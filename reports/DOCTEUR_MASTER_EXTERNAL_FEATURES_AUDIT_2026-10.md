# DOCTEUR — MASTER EXTERNAL PROJECTS + FEATURES AUDIT V1

Date : 2026-10-01 · Mode : **AUDIT ONLY / READ ONLY** · Projet : `C:\dev\Docteur` · Branche `main` @ `3eb24c4`
Aucune implémentation, aucune installation, aucun serveur externe, aucun code tiers exécuté. Voir §4 (méthode) et le checkpoint final (§28).

Légende des preuves utilisée partout :

| Tag | Signification |
|---|---|
| `[REPO]` | Lu ou mesuré par moi dans `C:\dev\Docteur` pendant cette mission (lecture seule). |
| `[WEB-P]` | Page officielle (README GitHub, doc éditeur, registre npm). **Passée par un modèle de résumé** (WebFetch) : le contenu d'un fichier LICENSE ou d'un `package.json` n'a pas été lu en brut → à relire au moment d'un éventuel pin. |
| `[WEB-S]` | Résultat de recherche / article tiers. Indicatif seulement. |
| `[KNOW]` | Connaissance générale, **non revérifiée** dans cette session. |
| `UNKNOWN` | Non démontré. Jamais compté comme PASS. |

---

## 1. Executive summary

**Verdict global : PASS_WITH_UNKNOWNS.** L'audit est complet sur le périmètre demandé ; les UNKNOWN sont listés au §27.

Dix constats qui changent la feuille de route :

1. **Beaucoup de ce qui est présenté comme « à construire » existe déjà dans Docteur** `[REPO]` : Code Intelligence lecture seule (6 fichiers de tests, 78/78 d'après son rapport), import d'historique IA + distillation + mémoire approuvée + mémoire du chat (NB-4 → NB-7), Sales Studio en brouillon uniquement, routeur d'images multi-providers (ComfyUI local + 3 clouds gratuits), intégration OpenMontage (AGPL isolée, SHA épinglé), Sherlock (pseudos), Kiwix, MAÎTRE (exécuteur avec arrêt par PID). L'ordre de développement proposé dans la mission (§27 du prompt) est donc corrigé au §25.
2. **« Observateur » n'est pas un module OSINT** `[REPO]` (`OBSERVATEUR_V1_2026-09.md`) : c'est la surveillance **passive de l'hôte** (connexions réseau / processus locaux, `netstat` + `tasklist`) issue de l'ancien Sentinel. Enrichir Observateur avec OSIRIS / God's Eye View mélangerait deux domaines. Recommandation : un module séparé « Investigation / Géo », jamais dans Observateur.
3. **Aucune extension navigateur, aucun code Native Messaging, aucun MCP, aucun QR/WebRTC, aucun superviseur de services n'existe** dans `C:\dev\Docteur` `[REPO]` (recherche exhaustive hors `node_modules`/`external`). Le code de l'extension personnelle de l'utilisateur n'est **pas** dans les fichiers fournis → **UNKNOWN** (§9).
4. **Failles réelles trouvées dans Docteur (lecture seule, non corrigées)** :
   * `assertSafeUrl` (`cortex-server/src/lib/url-security.js`) laisse passer `http://[::ffff:127.0.0.1]/` : le parseur WHATWG le normalise en `[::ffff:7f00:1]`, que la liste de tests (`::1`, `fc00:`, `fe80:`, `fd…`) ne reconnaît pas — **mesuré** avec `new URL()`. Il n'y a aucune résolution DNS (rebinding assumé hors périmètre dans le commentaire du fichier), pas de blocage CGNAT `100.64/10`, et `h.startsWith('fd')` **bloque à tort tout hôte commençant par « fd »** (ex. `fdic.gov`).
   * Quatre `fetch(..., { redirect: 'follow' })` sans re-validation de la cible (`image.js:64`, `comfyui-install-manager.js:258`, `comfyui-model-manager.js:80`, `free-ai-catalog.js:112`).
   * 168 routes des modules gelés (Device Fabric, OMEGA, RASSILON, MAÎTRE, Observateur) sont **exemptées** du garde central NB-7 (« residual / next-mission item » dans son propre rapport).
   * Aucun CSP sur le frontend ni sur l'API (NB-7 §12 + grep).
   * Pas de détection de **PII** dans l'import d'historique (seulement les secrets) ; mémoire non chiffrée au repos (BitLocker « évalué », pas recommandé).
   * `yt-dlp` et `ffmpeg` sont résolus par le PATH (`findBin()`, `spawn('ffmpeg')`) : non épinglés ; l'URL est passée en argument positionnel sans `--` (protégé en pratique par `assertSafeUrl` qui n'accepte que http/https).
   * **Le Notebook (au moins 42 fichiers dont le nom contient « notebook », plus les outils `nb3…nb7-*`) est certifié et « FROZEN » mais NON COMMITÉ** `[REPO]` : `git ls-files | grep notebook` = 11 fichiers suivis vs 42 non suivis. Le manifeste de gel SHA-256 est valide (`--verify` : 71 fichiers, 0 dérive) mais un `git clean` accidentel détruirait le travail.
5. **Plugin4Shell est réel** `[WEB-P]` (Air Security, mai 2026) : les agents font `git checkout <SHA>` sans vérifier que `HEAD` = SHA ; une branche nommée comme le SHA (ou `FETCH_HEAD`) détourne le checkout ; l'auto-update propage sans clic. Correctifs : Claude Code **2.1.179**, Codex **0.146.0** ; Copilot non corrigé ; Gemini CLI déprécié. Claude Code installé ici : **2.1.269** `[REPO]` (`claude --version`) → au-dessus du correctif.
6. **Show Me The Money** : licence **CC BY-NC 4.0** (passée de MIT à CC-BY-NC en v2.2.0) `[WEB-P]`, `postinstall: node install.js` et `/money-upgrade` (remplacement de skills depuis npm) → **PLUGIN4SHELL-LIKE RISK : YES** (classe « mise à jour non vérifiée d'instructions exécutées avec l'autorité de l'agent », pas le bug git exact). `install.js` (branche `master`, lu en texte) ne fait que copier des fichiers dans `~/.claude/skills/` — mais le tarball npm publié n'a pas été comparé. **REJECT.**
7. **Obscura** : Apache-2.0, très jeune, issues ouvertes de sécurité (#1056 « SSRF gate skipped », #1053 injection de cookie inter-IP, #1046 DoS CPU) `[WEB-P]`, mode `--stealth` (usurpation d'empreinte, `isTrusted=true`) incompatible avec l'esprit « pas de contournement ». Docteur a déjà Playwright + Readability. **DEFER.**
8. **Scrapling** : BSD-3, mais `StealthyFetcher` « Cloudflare Turnstile out of the box » = contournement anti-bot ; `scrapling install` télécharge navigateurs + dépendances système ; aucune protection SSRF documentée. **ADAPT_IDEAS_ONLY** (parsing adaptatif), jamais le stealth.
9. **Licences piégeuses** : Cap = **AGPL-3.0** (sauf crates `cap-camera*`/`scap-*` MIT) ; Postiz = AGPL-3.0 ; Cover Your Tracks = AGPL-3.0 ; Show Me The Money = CC BY-NC ; PDF24 = freeware propriétaire (usage séparé des composants **non permis**) ; God's Eye View = code MIT mais **datasets et tuiles Google 3D sous termes séparés** (non-commercial) ; OpenSanctions (utilisé par OSIRIS) = `[KNOW]` CC BY-NC, à vérifier.
10. **Ce qu'il faut vraiment construire** (BUILD_NATIVE) : Root Policy, Runtime Supervisor (processus **externe** à Cortex), Web Egress Guard (nouveau, prérequis), Browser Media Bridge (dès réception du code de l'extension), QR Transfer, Document Toolbox, Recorder. Le reste est CONNECT_EXISTING, AUDIT_FURTHER, DEFER ou REJECT.

Sidecars recommandés : **Auto-Editor** uniquement (binaire épinglé + SHA-256 + arguments typés). Intégration directe : **aucune**. Recréations natives : Recorder (Cap), QR Transfer, Document Toolbox, Root Policy, Supervisor.

---

## 2. Current Docteur state (inspection READ ONLY)

### 2.1 Baseline Git `[REPO]`

* `main` @ `3eb24c4` (2026-09-29), 27 commits. 146 entrées `git status` : 20 fichiers modifiés (`deep-capture.js`, `lancedb.js`, `router.js`, `ytdlp.js`, `server.js`, `App.tsx`, `SearchConsole.tsx`, `NotebookModal.tsx`, …) + 126 non suivis (scripts d'audit/benchmarks `audit-*`, `nb3…nb7-*`, 42 fichiers Notebook).
* Ces modifications relèvent d'autres missions (article capture, YouTube Smart Discovery V2, NB-7) — **non touchées** par cet audit.
* **Les mémoires internes (MEMORY.md) disaient « uncommitted » pour Device Fabric / OMEGA V2 / RASSILON : c'est obsolète.** Vérifié : `device-fabric` 23 fichiers suivis / 0 non suivi / 0 modifié ; `omega-outbound` 26/0/0 ; `rassilon` 47/0/0 ; `maitre` 52/0/0 ; `monitor` 29/0/0. Seul le **Notebook** reste non commité.

### 2.2 Statut réel des modules (preuves = rapports + Git + manifeste ; **je n'ai pas relancé les suites de tests**)

| Module | Rapport de certification | Statut déclaré | Vérifié par moi | Gel appliqué par outil ? |
|---|---|---|---|---|
| Device Fabric V1 | `DEVICE_FABRIC_V1_FINAL_CERTIFICATION_2026-09.md` (2026-09-24) | « PASS — FROZEN » (ligne 249) | rapport lu ; fichiers suivis, 0 modification | Non : convention + `test-device-fabric-static-audit.mjs` (23 contrôles) |
| Device Fabric V2 | `DEVICE_FABRIC_V2_FINAL_CERTIFICATION_2026-09.md` (2026-09-29) | « FINAL — CERTIFIED — FROZEN » | idem | idem |
| OMEGA V1 | `OMEGA_V1_FINAL_CERTIFICATION_2026-09.md` | « PASS pour le périmètre gelé » ; régression globale **PARTIAL** (6 non-passants historiques hors OMEGA) | idem | Non |
| OMEGA V2 outbound | `OMEGA_V2_FINAL_CERTIFICATION_2026-09.md` (2026-09-28) | PASS ; 77/77 backend, 232/232 navigateur ; **second appareil réel : NOT_RUN** ; input Windows réel : NOT_RUN | idem | Non |
| RASSILON V1 | `RASSILON_V1_FINAL_CERTIFICATION_2026-09.md` | « Freeze status : FROZEN », PASS | idem | Non |
| MAÎTRE V1 | `MAITRE_V1_2026-09.md` (MA-12) | « Freeze status : FROZEN » | idem | Non |
| Observateur V1 | `OBSERVATEUR_V1_2026-09.md` | livré (surveillance passive hôte) | idem | Non |
| Notebook NB-2→NB-7 + AI History + Docteur Memory | `…NB7_FINAL_CERTIFICATION_2026-09.md` (2026-09-30) | « Notebook FROZEN ; Docteur Memory FROZEN » ; 274/274 backend | **`node nb7-freeze-manifest.mjs --verify` → 71 fichiers, drift `[]`, exit 0** | **Oui** (SHA-256 des fichiers) — mais non commité |
| Code Intelligence RO | `CODE_INTELLIGENCE_READONLY_CHECKPOINT_2026-09-22.md` | « CERTIFIED GREEN », 78/78 | code lu : `execFile`/`spawn` `shell:false`, git `status/diff/log/show` | Non |
| Sales Studio V1 | `BUSINESS_SALES_AGENT_V1_CHECKPOINT_2026-09-22.md` | « DRAFT — NOT SENT » | registre `capabilities.ts` lu | Non |
| Docteur global | `DOCTEUR_FINAL_CERTIFICATION_2026-09.md` | « PASS AVEC LIMITATIONS » (510/511) | — | — |

Ne pas conclure plus : **« FROZEN » est une convention documentaire pour tout sauf le Notebook** (seul à avoir un manifeste vérifiable). Pour DF/OMEGA/RASSILON/MAÎTRE, la protection est : fichiers commités + tests statiques + discipline de mission.

### 2.3 Inventaire des capacités demandées au §2 du prompt

| Élément | Existe ? | Preuve / remarque |
|---|---|---|
| AI/LLM local | Oui | `ollama.js`, `router.js`, `local-ai-*`, `local-model-fit.js`, `local-hardware-profile.js` |
| Strict Local | Oui, centralisé | `strict-local.js` (`isStrictLocalMode`, `assertCloudAllowed` 503) + `privacy-guard.js` + `test-strict-local-centralized.mjs` |
| Feature Registry / Local Explainer | Oui | `src/content/capabilities.ts` (`HELP_DIRECTORY`, `FeatureKey`, états `local`/`disponible`/`a_configurer`) + `scripts/test-feature-registry.mjs` |
| Notebook / notes / RAG / embeddings | Oui | `notebook-*.js` (FTS + LanceDB `lancedb.js`), citations vérifiées |
| Import d'historique ChatGPT/Claude/Gemini | Oui (**synthétique seulement**) | `notebook-ai-adapters.js` : « SYNTHETIC_ONLY », validation réelle NOT_RUN |
| Mémoire Docteur approuvée | Oui | `notebook-memory.js`, `chat-memory.js` (NB-5/NB-7) |
| Media / vidéo | Partiel | `video-pipeline`, `video-audio-download.js`, `whisper*.js`, `openmontage-*.js` (Remotion local), `ytdlp.js`, `youtube-discovery.js` |
| Génération d'images | Oui | `image-router.js` (`local_only` / `free_cloud` / `auto`), providers `comfyui`, `cloudflare`, `huggingface`, `pollinations` |
| Connecteurs externes | Oui | `connector-registry.js` (YouTube/Drive/OneDrive OAuth PKCE, `pkce.js`) |
| Plugins / MCP | **Non** | 0 occurrence `modelcontextprotocol` ; « Compétences (Skills) » = bibliothèque interne |
| Agents | Oui | `agent-runner.js`, `external-agents.js` (Claude/Codex CLI en workspace isolé), MetaGPT (Ollama, apply approuvé par hash) |
| Code search / Git RO | **Oui** | `code-intel-search.js` (ripgrep, symboles par regex), `code-intel-git.js`, `code-intel-workspace.js` |
| Transfert de fichiers / QR | **Non** | 0 occurrence `qrcode|filepizza|peerjs|RTCPeerConnection` |
| Extension navigateur / Native Messaging | **Non** | 0 `manifest_version` / `nativeMessaging` dans le repo (le seul `manifest.json` du dossier `C:\dev` est `PlaceToBe/public`, projet sans rapport) |
| Superviseur de processus | **Non** | Lancement par `.bat` (`Docteur-Launcher.bat`, `start-local.bat` : `start "…" cmd /k …`, chemins `C:\dev\Docteur` en dur) ; `port-preflight.js` ; `process-tree.js` (taskkill /T /F sur PID spawné par Docteur) |
| Policy/security globale | **Partielle, éclatée** | `local-request-guard.js` + `local-api-policy.js` (NB-7, 459 routes non gelées prouvées) ; `strict-local.js` ; `privacy-guard.js` ; `maitre-policy.js` ; `external-agent-policy.js` ; `sherlock-policy.js` ; `metagpt-policy.js` ; `cyber-policy.js` ; `sales-policy.js` ; `kiwix-policy.js` ; `openmontage-policy.js`. **Pas de primitive d'approbation commune** (confirmé par `AGENCY_AGENTS_AUDIT` : « five independent verticals »). |
| Gestion de secrets | Oui | `secret-store.js` : DPAPI (CurrentUser) via PowerShell ; `secret-scan.js` |
| Réseau LAN | Oui, TLS obligatoire | `server.js` l.146-148 : `LOCAL_NETWORK=true` sans certificat ⇒ **refus de démarrer** (jamais de cleartext LAN) |

---

## 3. Frozen module boundaries

Règle appliquée : **ce rapport ne modifie rien dans ces périmètres** et toute future mission qui les touche doit être explicitement une mission « unfreeze ».

| Périmètre gelé | Fichiers (racines) | Contrôle de dérive | Conséquence pour la suite |
|---|---|---|---|
| Notebook / AI History / Docteur Memory / chat memory / local guard | `notebook-*.js`, `chat-memory.js`, `local-request-guard.js`, `local-api-policy.js`, routes `notebook*.js`, `Notebook*.tsx`, `ChatMemoryControls.tsx`, tests/outils `nb2…nb7` | `nb7-freeze-manifest.mjs --verify` (**OK**) | Memory Import réel = AUDIT_FURTHER (validation), pas un nouveau module |
| Device Fabric V1/V2 | `device-fabric*.js`, `routes/device-fabric.js`, `DeviceFabric*.tsx` | test statique #23 + git | QR Transfer doit **n'importer rien** de ces fichiers (le test statique l'a déjà fait échouer pour une simple mention d'URL en NB-7) |
| OMEGA V1/V2 | `omega-*.js`, `omega-*.ps1` | tests | Recorder ≠ `omega-capture.ps1` (domaines de confiance distincts) |
| RASSILON | `rassilon-*.js` | tests | idem |
| MAÎTRE | `maitre-*.js` | tests | Le Supervisor ne doit pas réutiliser `maitre-executor.js` (cibles de processus arbitraires par PID vs liste fermée) |
| Observateur | `monitor-*.js`, `cyber-*.js` | tests | Pas d'enrichissement OSINT (§1.2) |

Frontière à traiter **dans une mission dédiée** (pas ici) : les 168 routes exemptées du garde NB-7 (DNS-rebinding / Origin / Sec-Fetch). C'est le candidat n°1 de durcissement selon NB-7 lui-même.

---

## 4. Method

1. **Docteur d'abord** (lecture seule) : `git status/ls-files/log`, lecture des rapports de certification, du code des garde-fous (`strict-local`, `url-security`, `secret-store`, `local-request-guard`, `process-tree`, `external-agent-policy`, `code-intel-*`, `ytdlp`, `notebook-ai-adapters`), du registre de fonctionnalités, des lanceurs `.bat`, `package.json` (racine + serveur).
2. **Seules commandes exécutées** : commandes Git de lecture ; `ls`/`grep` ; `node nb7-freeze-manifest.mjs --verify` (script **de Docteur**, lit des fichiers et calcule des hash, n'écrit rien en mode `--verify`) ; `node -e` limité à `new URL(...)` pour mesurer la normalisation (aucun réseau) ; `claude --version`. **Aucun script ni binaire d'un projet audité.**
3. **Externe** : requêtes HTTP GET de documentation uniquement (pages GitHub, registre npm en métadonnées, `install.js` de Show Me The Money **lu comme texte**, docs Chrome/ITAD, recherches web). Aucune donnée Docteur envoyée ; les requêtes ne contenaient que des noms de projets publics.
4. **Limites assumées** : (a) les pages passent par un résumeur → `[WEB-P]` à reconfirmer sur fichier brut avant tout pin ; (b) pas de `LICENSE` lu en brut ; (c) je n'ai **pas** relancé les suites de tests de Docteur (non nécessaire à un audit, et plusieurs écrivent dans `data-test-*`) ; (d) pas d'analyse de code source tiers ligne à ligne (aucun clonage interdit/autorisé : je n'ai rien cloné) → les risques d'exécution/shell des projets tiers sont dérivés de leur documentation officielle et marqués comme tels ; (e) aucun avis juridique : les passages « légal » signalent des risques, pas des conclusions.

---

## 5. Master security model

### 5.1 Principes (déjà vrais / à rendre vrais)

| # | Principe | État dans Docteur `[REPO]` |
|---|---|---|
| P1 | Strict Local par défaut | **Vrai** pour le chat/mémoire/Notebook (prouvé : spy réseau NB-7, 0 appel). Pas une règle **centrale** applicable à tout nouveau module : chaque route doit appeler `assertCloudAllowed`. |
| P2 | Un secret n'atteint jamais un modèle/provider sans autorisation | Partiel : `privacy-guard.js` + `secret-scan.js` + `sanitize()`/`redactSecrets` dans les agents externes ; DPAPI pour les clés. Pas de garde unique sur *tous* les sortants. |
| P3 | Aucun contournement d'authentification / paiement / accès | Non encodé en code ; respecté par design dans chaque module. **Doit devenir une règle racine** (§12). |
| P4 | Action à fort impact ⇒ approbation humaine locale | Réalisé verticalement (MetaGPT = hash SHA-256 lié ; external-agents = preview→approve 5 min→execute→review→undo ; MAÎTRE ; OMEGA admin). **Pas de primitive commune** (gap confirmé). |
| P5 | Pas de shell arbitraire pour une IA | Respecté : `shell:false` partout où lu (code-intel, process-tree, external-agent-process, ytdlp). **Contre-exemples à noter** : `.bat` avec `cmd /k` (lancement humain, pas IA) ; `secret-store.js` lance PowerShell avec `-ExecutionPolicy Bypass` et une chaîne composée (valeurs en base64 → pas d'injection, mais c'est un pattern à ne pas généraliser). |
| P6 | Domaines de confiance séparés | Excellent pour DF/OMEGA/RASSILON (clés distinctes, test statique). À étendre à Transfer/Media. |
| P7 | STOP/révocation prioritaire | Réalisé pour OMEGA/RASSILON/DF (STOP global, tests). Pas de STOP transverse. |
| P8 | Les IA/plugins/outils ne modifient pas la policy | Il n'y a pas de policy centrale → question vide aujourd'hui (§12). |
| P9 | UNKNOWN ⇒ fail closed pour les opérations protégées | Appliqué dans DF (`AGENT_ERROR` → refus), garde NB-7 (Host mal formé ⇒ 403). Pas systématique. |

### 5.2 Modèle de confiance de l'API locale

`local-request-guard.js` : l'API n'a **pas d'authentification utilisateur** ; un processus du même compte Windows est de confiance. Ce qui est refusé : une **page web** (CSRF, DNS rebinding via Host, Origin d'un autre port loopback, `Origin: null`, `Sec-Fetch-Site: cross-site` sur méthode non sûre). Preuve : 459 routes non gelées, 627 routes extraites, 0 handler atteint par une requête hostile. **Conséquence de conception pour tout nouveau module** : il hérite gratuitement de ce garde s'il est monté comme les autres routes ; il **ne** doit **pas** ouvrir son propre listener sans refaire cette analyse (sauf QR Transfer, §11, qui est par nature un listener éphémère distinct).

### 5.3 Cinq règles transverses pour toute nouvelle fonctionnalité de cet audit

1. **Web Egress Guard unique** (nouveau, §5.4) pour toute requête sortante déclenchée par une URL non littérale.
2. **Arguments typés, jamais de chaîne shell** ; liste fermée d'exécutables épinglés par chemin absolu + SHA-256 (modèle `sherlock-pin.json`, `external/OpenMontage` @ SHA).
3. **Données externes = DATA** : jamais d'instruction système (modèle NB-4/NB-5 : `authority: CONTEXT_ONLY`, bornes aléatoires par requête).
4. **Approbation liée au hash de l'action** (modèle MetaGPT), à usage unique, expirante.
5. **Fail closed + audit** : composant de sécurité indisponible ⇒ refus + événement.

### 5.4 Web Egress Guard (prérequis transversal — **nouveau, non demandé**)

Constat `[REPO]` : 36 appelants de `assertSafeUrl`, mais le garde est insuffisant pour un module de recherche web, un Media Bridge ou un Investigator (voir §1.4). Spécification minimale d'une future mission :

* schémas `http`/`https` uniquement ; rejet `userinfo` ; normalisation WHATWG ;
* résolution DNS **suivie d'un contrôle de l'IP réellement connectée** (rebinding), IPv4-mappé IPv6, `100.64/10`, `169.254.169.254` (metadata), `0.0.0.0/8`, multicast, `::`, ULA, link-local ;
* `redirect: 'manual'` + re-validation à chaque saut (max N) ;
* taille bornée en streaming, `Content-Type` vérifié, timeout total, pas d'écriture disque arbitraire ;
* journalisation sans URL complète (hôte seul) ;
* tests : corpus SSRF classique (décimal/octal/hex, `[::ffff:…]`, `localtest.me`-style, redirections 30x vers `127.0.0.1`).
Décision : **BUILD_NATIVE, phase P0**, avant tout module web.

---

## 6. Plugin4Shell / supply-chain audit

### 6.1 Ce qu'est Plugin4Shell `[WEB-P]`

Agents (Claude Code, Codex, Copilot) : `git clone <repo> ./` puis `git checkout <SHA épinglé>` **sans vérifier** que `HEAD == SHA`. Un attaquant qui contrôle le dépôt crée une **branche nommée comme le SHA** (et la rend branche par défaut) : Git préfère la branche à l'objet commit → le code attaquant est exécuté alors que le « pin » semble respecté. Variante Gemini CLI : `git checkout FETCH_HEAD` avec une branche nommée `FETCH_HEAD`. L'auto-update re-exécute la procédure en arrière-plan → **zéro clic**. Correctif attendu côté agent : `git rev-parse HEAD` après checkout. Versions corrigées : Claude Code 2.1.179 (17 juin 2026), Codex 0.146.0 (12 août 2026) ; Copilot : pas de patch ; Gemini CLI : déprécié.

### 6.2 Posture de Docteur lui-même

| Point | Constat `[REPO]` | Évaluation |
|---|---|---|
| Claude Code local | 2.1.269 | ≥ 2.1.179 : **OK** pour la variante git connue |
| Dépendances externes déjà intégrées | `external/OpenMontage` @ `08e2151f…` (HEAD détaché, jamais `main`), `external/MetaGPT` (wheels pip épinglées, `requirements-docteur-v1-wheels.txt`), `sherlock-pin.json` (SHA du dépôt + SHA-256 par fichier) | **Bon modèle** à généraliser. Vérification post-checkout par `git rev-parse HEAD` : à ajouter dans les scripts d'installation futurs (manquait aux outils actuels : UNKNOWN s'il existe) |
| npm | `package-lock.json` racine + serveur ; plages `^` ; `postinstall` racine = `copy-mediapipe-wasm.mjs && copy-tesseract-assets.mjs` (scripts **internes**, copient des assets) | Lockfile = bon ; **pas d'allowlist de paquets**, pas de `npm ci --ignore-scripts` documenté |
| Binaires | `yt-dlp` / `ffmpeg` via PATH, version non épinglée, pas de hash | **Gap** (confiance au PATH) |
| Playwright | `^1.61.1` ; téléchargement navigateur = commande séparée | OK s'il reste manuel |
| Auto-update | Aucun mécanisme d'auto-update de Docteur trouvé ; OMEGA : « auto-update » confirmé **absent** (certification) | OK |

### 6.3 Grille Plugin4Shell par projet (réponse explicite exigée)

Légende : **YES** = mécanisme de mise à jour/installation permettant une substitution non vérifiée de code ou d'instructions exécutés avec une autorité élevée, démontré par des éléments techniques ; **POSSIBLE** = ingrédients présents, non démontré ; **NO** = pas de code installable (SaaS) ; **UNKNOWN**.

| Projet | Plugin4Shell-like | Éléments techniques `[WEB-P]` sauf mention |
|---|---|---|
| Show Me The Money | **YES** | `postinstall: node install.js` ; installe 25 skills dans `~/.claude/skills/` (instructions exécutées avec l'autorité de l'agent) ; `rmSync(force)` des dossiers existants ; `/money-upgrade` télécharge depuis npm et remplace ; installable aussi par `plugin marketplace add` (chemin git exact de Plugin4Shell, corrigé côté client ≥ 2.1.179) ; aucun hash/signature/provenance vérifiable ; paquet npm sous scope `@orrisai`, dépôt sous `iamzifei` (mainteneur npm `james_orris`) → lien de propriété à vérifier ; licence changée MIT→CC BY-NC (v2.2.0) = signal de dérive |
| Scrapling | POSSIBLE | `scrapling install` télécharge navigateurs + dépendances système + outils d'empreinte ; image Docker `pyd4vinci/scrapling` (tag non épinglé) ; serveur MCP ; `pip install "scrapling[all]"` |
| Obscura | POSSIBLE | `curl -LO <release> | tar xzf` ; checksums/signatures **UNKNOWN** ; image Docker `h4ckf0r0day/obscura` ; serveur MCP (14 outils) ; plugin « Hermes » tiers ; V8 compilé depuis les sources au build |
| Open-Higgsfield | POSSIBLE | `git clone --recurse-submodules` (sous-modules = pointeurs Git mutables) ; installeurs Electron (NSIS) ; Docker |
| Cap | POSSIBLE | monorepo Bun/Rust énorme ; Tauri (updater : UNKNOWN) ; Docker Compose ; Tinybird |
| OpenPlanter | POSSIBLE (+ risque d'exécution agent **élevé**, §7.8) | `pip install -e .` ; installeurs Tauri ; l'agent a `run_shell`, `write_file`, `fetch_url` |
| God's Eye View | POSSIBLE | installeur **Pinokio** « one-click » (exécute des scripts) ; `npm ci` avec lockfile (bon) |
| OSIRIS | POSSIBLE | `npm install` Next.js ; `docker pull …/osiris:latest` (tag mutable) |
| Auto-Editor | POSSIBLE (faible) | binaire statique ; pas de checksum/signature visibles `[WEB-P]` ; pas d'`install.js` connu |
| Memos | POSSIBLE (faible) | images Docker `stable`/`canary` (mutables) |
| Chatwoot | POSSIBLE | Rails + gems ; `hub.chatwoot.com` (phone-home, `DISABLE_TELEMETRY`) ; Docker |
| Postiz | POSSIBLE | monorepo pnpm, Docker, Temporal |
| FilePizza | POSSIBLE (faible) | dépendance **runtime** à `0.peerjs.com` + `stun.l.google.com` par défaut |
| qrcp | POSSIBLE (faible) | binaire Go ; vérification des releases non documentée |
| Cover Your Tracks | POSSIBLE (faible) | Pipenv/Docker/MySQL ; domaines tiers au runtime |
| TwitchNoSub | POSSIBLE | chargement « unpacked » depuis releases ; une extension du store s'auto-met à jour silencieusement (classe de risque connue) — non audité plus loin (§7.6) |
| PDF24 | POSSIBLE | installeur propriétaire avec son propre updater (non retenu) |
| TinEye, Namechk, GetHuman, IsThereAnyDeal, MyFridgeFood | **NO** | services web/API sans code installable (le risque est celui d'un tiers distant, traité en §21/§22) |
| Extension navigateur de l'utilisateur | **UNKNOWN** | code non fourni |

### 6.4 Recommandations d'installation (toute future intégration)

1. **Commit exact** (40 hex) + `git rev-parse HEAD` comparé **après** checkout, en échec fermé ; ne jamais `git checkout <nom>` ambigu : utiliser `git fetch --depth 1 origin <sha>` puis `git checkout --detach FETCH_HEAD` **et** comparer, ou `git -c advice.detachedHead=false checkout --detach <sha>^{commit}`.
2. Vérifier `git cat-file -t <sha>` = `commit`, et refuser si une **branche ou un tag porte ce nom** (`git show-ref`).
3. **Hash SHA-256 du binaire** consigné dans un fichier de pin versionné (modèle `sherlock-pin.json`), vérifié avant chaque exécution (pas seulement à l'installation).
4. npm : `npm ci --ignore-scripts`, allowlist de paquets, `npm audit signatures` (provenance) quand disponible, pas d'`npx` de paquets non épinglés. Python : `--require-hashes` + wheels uniquement (déjà fait pour MetaGPT).
5. **Installation hors-ligne** depuis un miroir local après audit ; **aucune mise à jour automatique** (supprimer/neutraliser updaters).
6. Registre d'**inventaire SBOM** minimal (CycloneDX) généré à l'installation, comparé à l'audit.
7. Jamais de skills/plugins/MCP tiers dans l'environnement qui édite Docteur sans pin + revue du contenu des skills (ce sont des instructions, donc un canal d'injection).

---

## 7. External project audits

Rappel : sauf mention `[REPO]`, les faits viennent de pages officielles résumées (`[WEB-P]`). Aucun code tiers n'a été cloné ni exécuté ; les champs « Shell/process execution », « Filesystem access » etc. décrivent donc **ce que la documentation officielle déclare**, pas ce qu'une lecture de code a confirmé. Un champ marqué UNKNOWN reste à auditer sur le **commit exact** avant toute installation.

Coûts (§26 du prompt) : indiqués dans la matrice réseau/coût (§21).

### 7.1 OPEN-HIGGSFIELD

Identity: « Open Higgsfield AI » / « Open Generative AI » (le README affiche « Open Generative AI »). **Plusieurs dépôts homonymes/forks existent** (avabbbb, thecoldblooded, sunnychase, Autom8AI, Anil-matcha) `[WEB-S]` → la première étape de tout futur audit est de **fixer le dépôt canonique** ; j'ai audité `Anil-matcha/Open-Higgsfield-AI` (celui référencé par la doc Mintlify et par muapi.ai). Studio d'images/vidéo/« cinéma » à prompt unique, façade d'une passerelle multi-modèles. 29,5 k étoiles, 5,4 k forks ; dernière release lue : v1.0.9 (date UNKNOWN) ; contributeurs UNKNOWN ; statut : projet populaire récent, stabilité UNKNOWN.  
Official repository: `https://github.com/Anil-matcha/Open-Higgsfield-AI`  
Official website: démo hébergée `muapi.ai/open-higgsfield-ai`  
Latest relevant state: v1.0.9 ; Windows NSIS x64/ARM64, macOS, Linux ; Web.  
Platform: Windows/macOS/Linux/Web  
Languages: JavaScript/JSX, Next.js 14, React 18, Tailwind 3, Node ≥ 18, monorepo npm workspaces  

License: MIT (racine) `[WEB-P]`  
Mixed licensing: UNKNOWN (sous-modules `--recurse-submodules` non audités ; moteurs **sd.cpp** et **Wan2GP** embarqués/pilotés ont leurs propres licences ; les **modèles** (SD 1.5/SDXL/Flux/Wan/Hunyuan/LTX) ont des licences distinctes, parfois non-commerciales)  
Asset/data restrictions: modèles tiers via passerelle : conditions du fournisseur de la passerelle (muapi.ai) et de chaque modèle — UNKNOWN  

Primary functionality: génération texte→image, image→image, texte→vidéo, image→vidéo, lip-sync, etc., 400+ modèles via **une passerelle commerciale unique** ; moteurs locaux uniquement dans l'app desktop.  

Network behavior: POST `/api/v1/{endpoint}` puis polling `/predictions/{id}/result` ; upload d'images vers `/api/v1/upload_file` (**l'image utilisateur part chez un tiers**).  
Cloud dependencies: **muapi.ai requis** pour le mode principal ; local = sd.cpp (embarqué) / Wan2GP (serveur Gradio fourni par l'utilisateur)  
Secrets: clé Muapi stockée en **`localStorage`** du navigateur (en clair), en-tête `x-api-key`  
Telemetry: non documentée → UNKNOWN  

Shell/process execution: desktop Electron lance sd.cpp ; Docker ; UNKNOWN pour le reste  
Filesystem access: Electron : UNKNOWN  
Browser access: app web Next.js  
MCP/plugins: UNKNOWN (non mentionné)  

Strict Local: **STRICT_LOCAL_PARTIAL** — le mode local existe seulement dans l'app Electron avec sd.cpp ; le chemin principal exige le cloud.  
Security findings: clé API en `localStorage` ; upload d'images vers tiers ; surface Electron complète UNKNOWN.  
Supply-chain findings: sous-modules Git, installeurs binaires, Docker.  
Plugin4Shell-like risk: POSSIBLE (§6.3)  

Overlap with Docteur: **élevé** — `image-router.js` fournit déjà `local_only|free_cloud|auto` + abstraction par provider (ComfyUI local ; Cloudflare/HuggingFace/Pollinations gratuits) `[REPO]`. Studio vidéo local = OpenMontage (Remotion) `[REPO]`.  

Possible integrations:  
1. Intégrer l'application — **non** (doublon + cloud + clé en clair).
2. Ajouter un `MediaProvider` générique (même contrat que `image-router`) pour y brancher *éventuellement* une passerelle payante — **optionnel, derrière Strict Local OFF + consentement par appel**.
3. Reprendre l'idée : une abstraction `submit → poll → fetch` avec coûts estimés affichés avant l'appel.

Recommended architecture: étendre `image-router.js` en `MediaProvider` (image/vidéo) ; providers cloud désactivés par défaut ; coût estimé + confirmation ; aucun upload d'image sans case explicite ; clé en DPAPI (`secret-store.js`), jamais `localStorage`.  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: l'abstraction multi-provider existe déjà dans Docteur ; le gain net (400 modèles) passe par un tiers payant qui reçoit les prompts/images.  
Prerequisites: aucun (idée seulement).  
Blockers: aucun pour l'idée ; licence des modèles/passerelle pour toute intégration.  
Open questions: quel dépôt est canonique ? tarifs muapi.ai ? politique de rétention des images chez la passerelle ?  

### 7.2 CAP

Identity: Cap — enregistreur d'écran open source (alternative Loom). Stable/bêta : **UNKNOWN** (« prêt pour production » non confirmé) ; dernière release : UNKNOWN ; contributeurs : UNKNOWN.  
Official repository: `https://github.com/CapSoftware/Cap`  
Official website: cap.so `[WEB-S]`  
Latest relevant state: Tauri v2 (SolidStart + Rust), web Next.js, Drizzle + MySQL, Effect, Bun 1.4+, Node 20+, Rust 1.88+  
Platform: macOS, **Windows (confirmé)**  
Languages: Rust, TypeScript  

License: **AGPL-3.0 (racine)** `[WEB-P]`  
Mixed licensing: crates **`cap-camera*` et `scap-*` sous MIT** ; composants tiers sous leurs licences ; reste du monorepo AGPL  
Asset/data restrictions: UNKNOWN  

Primary functionality: capture écran/fenêtre/caméra/micro, modes Instant (upload pendant l'enregistrement) et Studio (édition locale), partage par lien.  

Network behavior: Cap Cloud (partage) ; S3 compatible (R2, B2, MinIO…) en auto-hébergé ; Tinybird pour la télémétrie de visionnage.  
Cloud dependencies: optionnelles (mode Studio local fonctionne sans) — non prouvé offline : UNKNOWN  
Secrets: clés S3/DB en auto-hébergé ; compte Cap Cloud  
Telemetry: Tinybird (visionnage) ; télémétrie de l'app desktop : UNKNOWN  

Shell/process execution: UNKNOWN (Tauri sidecars/FFmpeg probables)  
Filesystem access: enregistrements locaux  
Browser access: —  
MCP/plugins: UNKNOWN  

Strict Local: **STRICT_LOCAL_PARTIAL** (Studio local plausible, non démontré).  
Security findings: surface Tauri + web + base MySQL en auto-hébergé : large ; AGPL impose la publication du source si Docteur est « distribué/exposé réseau » avec du code Cap lié.  
Supply-chain findings: gros arbre Bun/Cargo ; updater Tauri UNKNOWN.  
Plugin4Shell-like risk: POSSIBLE  

Overlap with Docteur: partiel — `src/hooks/useScreenShare.ts` (capture écran navigateur) et OCR écran existent `[REPO]` ; **pas** d'enregistreur ni d'export vidéo. À séparer de `omega-capture.ps1` (capture distante OMEGA = autre domaine de confiance).  

Possible integrations:  
1. Cap complet comme application autonome que l'utilisateur lance lui-même (aucune intégration, aucune obligation AGPL pour Docteur) — option « zéro code ».
2. Sidecar piloté — **déconseillé** (aucune API de pilotage documentée ; AGPL si lié).
3. **Recorder natif** : `getDisplayMedia` + `MediaRecorder` (déjà permis par navigateur, invite de permission) ; option ffmpeg `ddagrab`/`gdigrab` pour l'audio système ; si besoin natif Rust : crate MIT `scap-*` seule.

Recommended architecture: module `media/recorder` : sessions explicites, indicateur visible permanent, STOP, sortie dans un dossier dédié, jamais de pipeline vers OMEGA ; export vers Auto-Editor (§7.3).  

Decision: **RECREATE_NATIVE**  
Reason: la valeur de Cap est la capture + montage léger ; la capture est faisable avec des API navigateur/ffmpeg sans AGPL ni cloud ; reprendre les crates MIT seulement si un besoin natif prouvé apparaît.  
Prerequisites: Root Policy (permissions CAMERA/MIC/SCREEN = OFF par défaut, §24), indicateur visible.  
Blockers: capture audio système via navigateur limitée (UNKNOWN selon navigateur).  
Open questions: besoin réel de caméra/overlay ? licence exacte des crates MIT (relire LICENSE par crate).  

### 7.3 AUTO-EDITOR

Identity: Auto-Editor (WyattBlue). Coupe automatique (silence/mouvement) + export timeline. 2 532 commits `[WEB-P]` ; **dernière release lue 31.6.0 (6 sept.)**, cadence ~2-3 semaines → très actif ; statut : stable en pratique, API CLI qui évolue (version majeure 31).  
Official repository: `https://github.com/WyattBlue/auto-editor`  
Official website: `auto-editor.com` (doc : `docs.auto-editor.com` a renvoyé une **erreur de certificat** lors de ma lecture → à noter, non contourné)  
Latest relevant state: 31.6.0 ; FFmpeg **embarqué statiquement** (31.5.0 : « bundled FFmpeg 9.0.1 », x264/x265/libvpx)  
Platform: Windows non confirmé dans mes lectures (UNKNOWN) ; macOS/Linux probables  
Languages: **Nim**  

License: Unlicense / domaine public (code) `[WEB-P]`  
Mixed licensing: **binaires** : FFmpeg + x264/x265 sont **GPL** → un binaire contenant x264/x265 est de fait GPL ; les « binary releases may use various open-source licenses » (README)  
Asset/data restrictions: aucun pour le code ; obligations GPL si Docteur **redistribue** le binaire (Docteur est local/personnel → l'utilisateur le télécharge lui-même : pas de redistribution)  

Primary functionality: détection de silence/mouvement, découpe, export MP4/timelines (Premiere, Resolve, FCP, Shotcut, Kdenlive).  

Network behavior: UNKNOWN (pas d'auto-update documenté dans ce que j'ai lu).  
Cloud dependencies: aucune connue  
Secrets: aucun  
Telemetry: UNKNOWN  

Shell/process execution: CLI ; ffmpeg interne ; **évaluation d'expressions/`--edit`** : syntaxe non lue (UNKNOWN : possibilité d'expression arbitraire à vérifier — le risque se traite en n'exposant **aucune** option libre)  
Filesystem access: lit/écrit les chemins qu'on lui donne  
Browser access: —  
MCP/plugins: aucun connu  

Strict Local: **STRICT_LOCAL_FULL (probable)** — à confirmer par test réseau (blocage sortant) sur le commit épinglé.  
Security findings: injection d'arguments si on compose une chaîne ; chemins d'entrée/sortie à confiner ; fichiers média malveillants (parseurs FFmpeg) → traiter comme non fiables.  
Supply-chain findings: binaire téléchargé, **checksums/signatures non visibles** `[WEB-P]`.  
Plugin4Shell-like risk: POSSIBLE (faible)  

Overlap with Docteur: partiel avec OpenMontage (rendu) et `ffmpeg` déjà utilisé par `whisper.js` ; **aucune** découpe automatique `[REPO]`.  

Possible integrations:  
1. **CLI sidecar** : `Docteur → arguments typés (liste fermée) → auto-editor.exe` (jamais une chaîne shell).
2. Bibliothèque : non (Nim).
3. Réimplémentation native de la détection de silence (ffmpeg `silencedetect`) — alternative sans nouveau binaire si le besoin se limite au silence.

Recommended architecture: `execFile(absolutePinnedPath, argv[])`, `shell:false`, `cwd` = répertoire de travail jetable, entrée = fichier copié dans le workspace (pas de chemin utilisateur brut), schéma d'options **énuméré** (`threshold`, `margin`, `export`), timeout + limite de taille de sortie, environnement filtré (modèle `filteredEnv` de `external-agent-policy.js`), blocage réseau vérifié par test, SHA-256 du binaire contrôlé avant chaque lancement.  

Decision: **CONNECT_AS_SIDECAR**  
Reason: capacité réellement absente, domaine public, usage local, surface d'argument contrôlable.  
Prerequisites: Root Policy (exécutable allowlisté) ; épinglage binaire + hash ; test d'absence de réseau.  
Blockers: confirmation Windows ; licence GPL du binaire à documenter.  
Open questions: syntaxe `--edit` exposant une évaluation ? version minimale épinglée ?  

### 7.4 EXTENSION NAVIGATEUR PERSONNELLE (code non fourni)

Voir §9. **Code inspecté : aucun (UNKNOWN).** Recherche faite sous `C:\dev\Docteur` (hors `node_modules`/`external`) et au premier niveau de `C:\dev` : aucun `manifest.json` d'extension, `.crx` ou dossier d'extension pertinent. Fiche complète : §9.  

### 7.5 YOUTUBE / TWITCH / DISCORD (accès légitime)

Voir §9.5 (architecture + interdits).  

### 7.6 TWITCHNOSUB — RÉFÉRENCE UNIQUEMENT

Identity: TwitchNoSub (besuper). Extension navigateur. 2,6-2,8 k étoiles, ~148 forks, 133 commits, « work in progress », 24 issues ouvertes ; dernière poussée : 12 nov. 2025 `[WEB-S]`.  
Official repository: `https://github.com/besuper/TwitchNoSub`  
Official website: —  
Latest relevant state: Chromium + Firefox (deux manifestes) ; dossier `userscript`  
Platform: navigateurs  
Languages: JavaScript  

License: **Apache-2.0** `[WEB-P]`  
Mixed licensing: UNKNOWN  
Asset/data restrictions: —  

Primary functionality: contenu **qui vise à contourner un contrôle d'accès** (VOD réservées aux abonnés) — **non documenté opérationnellement ici, volontairement**.  

Network behavior: UNKNOWN (non audité)  
Cloud dependencies: Twitch  
Secrets: UNKNOWN  
Telemetry: UNKNOWN  

Shell/process execution: aucun (extension)  
Filesystem access: —  
Browser access: injection dans le contexte de la page Twitch (présence d'un userscript) ; permissions du manifeste : **UNKNOWN (non récupérées)**  
MCP/plugins: —  

Strict Local: **CLOUD_REQUIRED** (dépend du service Twitch).  
Security findings (niveau architecture seulement) : dépend d'**internals non documentés** de Twitch → casse à chaque changement côté plateforme ; injection en contexte de page = surface XSS/élévation ; entre en conflit avec les conditions d'accès de la plateforme.  
Supply-chain findings: chargement « unpacked » depuis des releases ; mises à jour d'extension silencieuses (classe de risque générale).  
Plugin4Shell-like risk: POSSIBLE  

Overlap with Docteur: aucun.  

Possible integrations:  
1. Aucune.
2. Aucune.
3. **Leçons générales** pour le Media Bridge (§9) : une extension ne doit jamais dépendre de l'API privée d'un tiers ; limiter les permissions hôtes ; ne pas injecter dans la page si un `webRequest`/URL partagée par l'utilisateur suffit ; pas de mise à jour automatique non vérifiée.

Recommended architecture: sans objet.  

Decision: **REJECT**  
Reason: la fonction cœur est un contournement de contrôle d'accès (règle racine n°3) ; seules des leçons d'architecture générales sont conservées, sans reprise de mécanisme.  
Prerequisites: —  
Blockers: règle racine n°3 ; fragilité ; ToS.  
Open questions: aucune (hors périmètre).  

### 7.7 OSIRIS

Identity: OSIRIS — « Open Source Intelligence & Reconnaissance Integrated System » : tableau de bord mondial temps réel (vols, navires, caméras, séismes, incendies, actualités, météo spatiale, CVE, crypto, sanctions, Telegram public). Dépôt `simplifaisoul/osiris` ; **plusieurs forks** (bjdubb, carbon-evolution, JasonWilder117, WilliamTaack) `[WEB-S]`. 10,3 k étoiles, 2,1 k forks, 326 commits ; dernière activité : date UNKNOWN ; mainteneurs : un auteur principal ; statut : jeune, très actif.  
Official repository: `https://github.com/simplifaisoul/osiris`  
Official website: `osirisai.live` (démo hébergée) ; Patreon  
Latest relevant state: Next.js 16, TypeScript 5, MapLibre GL (WebGL), Docker `node:22-alpine` ~220 Mo non-root  
Platform: Web/Docker/Node  
Languages: TypeScript  

License: MIT (code) `[WEB-P]`  
Mixed licensing: **par source** : OpenSky (OAuth2, conditions d'usage), USGS (domaine public US), NASA FIRMS (clé), N2YO (clé), caméras de transport (TfL, WSDOT, Caltrans, ODOT, MDOT, HK, Taïwan, NZTA, Rijkswaterstaat, TxDOT…) : **conditions propres à chaque autorité**, OpenSanctions (OFAC SDN) `[KNOW]` CC BY-NC → vérifier, Telegram `t.me/s/<channel>` (scraping de pages publiques : ToS Telegram UNKNOWN)  
Asset/data restrictions: voir ci-dessus — **le code MIT ne couvre pas les données**.  

Primary functionality: agrégation multi-sources en une carte WebGL ; `SCANNER_URL`/`SCANNER_KEY` = « backend reconnaissance toolkit » (fonction offensive/reconnaissance **UNKNOWN**, à auditer avant tout).  

Network behavior: Next.js API routes → ~15 sources publiques ; tout le calcul lourd côté navigateur.  
Cloud dependencies: sources publiques (internet requis) ; certaines clés  
Secrets: `FIRMS_API_KEY`, `OPENSKY_CLIENT_ID/SECRET`, `N2YO_API_KEY`, `AIS_API_KEY`, `SCANNER_KEY`  
Telemetry: UNKNOWN (Vercel Edge pour la démo)  

Shell/process execution: UNKNOWN (le « scanner » backend)  
Filesystem access: UNKNOWN  
Browser access: rend des flux vidéo/caméras de tiers  
MCP/plugins: aucun mentionné  

Strict Local: **STRICT_LOCAL_PARTIAL** — l'app se lance en local mais ses données sont toutes distantes ; **hors-ligne = vide**.  
Security findings: agrégation de **17 000+ caméras publiques** et de posts Telegram : risques vie privée/éthique (pas de recherche de personnes) ; SSRF via routes Next.js qui proxifient des URL (à vérifier) ; clés côté serveur.  
Supply-chain findings: `npm install` Next.js ; `:latest` Docker.  
Plugin4Shell-like risk: POSSIBLE  

Overlap with Docteur: **Observateur n'est pas ce domaine** (hôte local, §1.2). Aucun module géospatial/OSINT mondial n'existe `[REPO]` (Sherlock = pseudos uniquement).  

Possible integrations:  
1. Intégrer l'app — non.
2. Sidecar d'une instance locale — non (surface Next.js + sources distantes).
3. **Reprendre une sélection de sources publiques sans clé** (USGS, NASA EONET, NOAA SWPC, NVD) comme *connecteurs de données* d'un module « Veille géo/événements » séparé, avec Web Egress Guard, cache, provenance et licence affichée.

Recommended architecture: connecteurs pull-only, allowlist d'hôtes, aucune caméra, aucun Telegram, aucun « scanner » ; chaque donnée taguée `OBSERVED` (source publique datée) vs `SIMULATED`.  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: valeur réelle faible-moyenne pour un assistant local ; les licences de données, le périmètre caméras/Telegram et le « scanner » sont des blocages ; aucune raison de toucher Observateur.  
Prerequisites: Web Egress Guard ; décision produit « module Investigation/Géo ».  
Blockers: licence de chaque source ; scanner UNKNOWN.  
Open questions: usage personnel vs commercial de Docteur ? besoin réel d'événements mondiaux ?  

### 7.8 OPENPLANTER

Identity: OpenPlanter (ShinMegamiBoson) — agent d'investigation récursif sur jeux de données hétérogènes (résolution d'entités, preuves, graphe). 115 commits ; releases `.dmg/.msi/.AppImage` ; contributeurs UNKNOWN ; statut : jeune/expérimental `[WEB-P]`.  
Official repository: `https://github.com/ShinMegamiBoson/OpenPlanter`  
Official website: UNKNOWN  
Latest relevant state: Python CLI (TUI + headless) + application **Tauri 2** (Rust + TypeScript/Vite) ; Cytoscape.js  
Platform: Windows `.msi`, macOS, Linux  
Languages: Python, Rust, TypeScript  

License: MIT `[WEB-P]`  
Mixed licensing: UNKNOWN  
Asset/data restrictions: dépend des jeux de données et des fournisseurs (Exa, Voyage)  

Primary functionality: 19 outils d'agent — fichiers (`read_file`, `write_file`, `edit_file`, `apply_patch`…), **shell (`run_shell`, `run_shell_bg`, `kill_shell_bg`)**, web (`web_search` via Exa, `fetch_url`), planification/délégation (`subtask`, `execute`) ; récursion max 4, 100 étapes/appel, shell timeout 45 s ; graphe de connaissances, « wiki » sourcé, curateur de wiki en arrière-plan.  

Network behavior: OpenAI, Anthropic, OpenRouter, Cerebras (cloud) ; **Ollama local supporté** (`http://localhost:11434/v1`) ; Exa (recherche web) ; Voyage (embeddings) ; `fetch_url` sur URL arbitraires.  
Cloud dependencies: par défaut oui ; **local possible** avec Ollama, mais recherche web et embeddings pointent vers des services cloud  
Secrets: clés fournisseurs (`--configure-keys`)  
Telemetry: UNKNOWN  

Shell/process execution: **OUI — shell arbitraire exposé à l'agent** ; garde-fous : « UNKNOWN — aucun bac à sable, modèle de permission ou contrainte documentés »  
Filesystem access: lecture/écriture/patch dans le workspace  
Browser access: `fetch_url`  
MCP/plugins: aucun mentionné  

Strict Local: **STRICT_LOCAL_PARTIAL** (possible seulement avec Ollama + sans Exa/Voyage).  
Security findings: RCE par design (outil shell piloté par un LLM qui lit des données non fiables → **injection de prompt indirecte = exécution de commandes**) ; SSRF via `fetch_url` ; écriture fichiers.  
Supply-chain findings: `pip install -e .` ; releases Tauri non signées ? UNKNOWN.  
Plugin4Shell-like risk: POSSIBLE (+ risque d'exécution agent **élevé**, hors mécanisme de mise à jour)  

Overlap with Docteur: **fort** — Notebook (citations, conflits, provenance), Sales Studio (provenance systématique, brouillon), Sherlock (OSINT durci, résultats `untrusted`), memoire NB-4/5 (hiérarchie de confiance) `[REPO]`. Manque : **graphe d'entités/preuves** et résolution d'entités.  

Possible integrations:  
1. Intégrer/sidecar OpenPlanter — **non** (`run_shell`).
2. Docteur Investigator natif : `RESEARCH → EVIDENCE → ENTITY RESOLUTION → GRAPH → HUMAN REVIEW` sans shell : outils = lecture de documents Notebook, `webFetch` via Egress Guard, parseurs ; les résultats sont des **propositions** (arêtes `PROPOSED`) validées à la main.
3. Reprendre : plafond de récursion/étapes, wiki sourcé, code couleur de catégories, sessions reprenables.

Recommended architecture: §15.  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: l'idée est précieuse, l'implémentation (shell + écriture + web sans bac à sable) est incompatible avec les règles de Docteur.  
Prerequisites: Web Egress Guard, Root Policy, stockage de graphe (SQLite tables) ; données utilisateur d'abord.  
Blockers: shell ; absence de modèle de permission.  
Open questions: besoin réel d'investigation (cas d'usage) ? tolérance aux faux positifs d'entity resolution par LLM ?  

### 7.9 GOD'S EYE VIEW

Identity: God's Eye View (bilawalsidhu) — « simulateur de satellite espion dans le navigateur, mais les données sont réelles » : globe 3D CesiumJS + 13 couches de données ouvertes. **45,9 k étoiles**, 9,4 k forks, 517 commits ; #1 GitHub Trending (août 2026) ; auto-déclaré « fondation hackable, **pas un service durci de production** » `[WEB-P]`.  
Official repository: `https://github.com/bilawalsidhu/gods-eye-view`  
Official website: version hébergée « Halfpixel » annoncée (non lancée)  
Latest relevant state: Vanilla JS + CesiumJS + Vite ; Node 24/26 ; installeur Pinokio  
Platform: navigateur ; Node  
Languages: JavaScript  

License: MIT (racine) `[WEB-P]`  
Mixed licensing: **jeux de données « soumis à des termes séparés » (DATA_SOURCES.md)** ; Google Photorealistic 3D Tiles : « usage personnel, non commercial éligible » via Cesium ion ; Google Maps API directe : facturée au-delà de 1 000 sessions/mois ; GIF promotionnels « non licenciés pour réutilisation autonome »  
Asset/data restrictions: **non commercial** pour les tuiles 3D ; avertissement explicite : ne pas utiliser pour navigation, urgence, médecine, investissement  

Primary functionality: couches : vols (OpenSky + adsb.lol), vols militaires (adsb.lol), navires (AISStream, inscription gratuite), satellites (CelesTrak), séismes (USGS), trafic (**simulé** sur routes OSM ; vitesses live TomTom avec clé), caméras CCTV (~3 600, APIs municipales), ALPR cartographiés (OSM — emplacements seulement), radio, incendies (NASA FIRMS), missions spatiales (Launch Library 2), vent (NOAA GFS/ECMWF), météo (NOAA nowCOAST). Voix : **OpenAI Realtime** (cloud, plafond 5 $).  

Network behavior: proxy serveur durci (« SSRF protection, caps de réponse ») qui détient les clés ; clés Google/Cesium côté navigateur.  
Cloud dependencies: toutes les couches ; voix OpenAI  
Secrets: clés OpenAI, AISStream, OpenSky OAuth, Google/Cesium, TomTom, FIRMS  
Telemetry: UNKNOWN  

Shell/process execution: UNKNOWN  
Filesystem access: cache TLE disque  
Browser access: WebGL/Cesium  
MCP/plugins: aucun mentionné  

Strict Local: **CLOUD_REQUIRED** (couches distantes) — fonctionne hors-ligne seulement avec fond de carte Esri/OSM… lui aussi distant.  
Security findings: serveur lié à `localhost` par défaut ; **`--host 0.0.0.0` expose les clés API à tout le LAN** (avertissement du dépôt) ; le projet affirme ne pas faire de recherche de personnes/reconnaissance faciale.  
Supply-chain findings: `npm ci` (bon) ; installeur Pinokio (scripts) ; dépendances Cesium.  
Plugin4Shell-like risk: POSSIBLE  

Overlap with Docteur: aucun (Observateur = hôte). Kiwix/`radio-catalog.js` : recoupement mineur sur la radio.  

Possible integrations:  
1. Intégrer — non.
2. Sidecar — non.
3. **Couches ouvertes sans clé** à prendre comme *idées de connecteurs* : séismes USGS, satellites CelesTrak, missions Launch Library 2, vent/météo NOAA. Étiquetage obligatoire **OBSERVED / MODELED / SIMULATED** (le dépôt lui-même simule le trafic).

Recommended architecture: connecteurs lecture seule derrière Web Egress Guard + cache ; aucune caméra, aucun ALPR, aucune voix cloud ; pas de faux « satellite espion » (le dépôt lui-même assume « simulator »).  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: spectaculaire mais faible valeur pour Docteur ; licences de tuiles/données non commerciales ; cloud requis ; caméras/ALPR sensibles.  
Prerequisites: Web Egress Guard ; décision produit.  
Blockers: DATA_SOURCES.md non lu en détail (UNKNOWN) ; tuiles Google non commerciales.  
Open questions: Docteur reste-t-il strictement personnel (condition des licences non commerciales) ?  

### 7.10 TINEYE

Identity: TinEye (Idée Inc., Canada) — moteur de recherche d'image inversée ; produits : API en ligne, MatchEngine (bibliothèque privée), MobileEngine, Alerts. Service commercial, activité continue `[WEB-S]`.  
Official repository: aucun (service propriétaire)  
Official website: `tineye.com` ; API : `services.tineye.com/developers`  
Latest relevant state: tarifs publics (blog TinEye) : 5 000 recherches = 200 $ (0,04 $/req), 10 000 = 300 $, 50 000 = 1 000 $, 1 M = 10 000 $ ; recherche web gratuite pour usage non commercial `[WEB-S]`  
Platform: API HTTP  
Languages: —  

License: conditions d'utilisation propriétaires (**non lues** : `tineye.com/terms` UNKNOWN)  
Mixed licensing: —  
Asset/data restrictions: usage commercial par quota payant ; rétention/stockage des images soumises : **UNKNOWN** (ma lecture de la doc dev n'a pas fourni le détail)  

Primary functionality: recherche par URL ou par upload → pages web contenant l'image ou ses variantes.  

Network behavior: l'image (ou son URL) est **envoyée à un tiers**.  
Cloud dependencies: **requis**  
Secrets: clé/identifiants API  
Telemetry: n/a  

Shell/process execution: aucun  
Filesystem access: aucun  
Browser access: —  
MCP/plugins: —  

Strict Local: **CLOUD_REQUIRED**.  
Security findings: fuite de contenu image vers un tiers (donc : consentement par requête, jamais pour des images marquées `local_only`/privées par `privacy-guard`) ; coût.  
Supply-chain findings: aucune (pas de code installé).  
Plugin4Shell-like risk: NO  

Overlap with Docteur: aucun moteur d'image inversée `[REPO]` ; `vision.js` (analyse d'image) est un autre sujet.  

Possible integrations:  
1. Provider derrière une interface `ReverseImageProvider` (TinEye ≈ 1 implémentation parmi d'autres).
2. Autres providers (moteurs web publics, upload manuel par l'utilisateur dans le navigateur — **zéro envoi automatique**).
3. **Recherche locale par hachage perceptuel** (pHash/dHash) pour retrouver doublons/variantes *dans la bibliothèque de l'utilisateur* — Strict Local, gratuit.

Recommended architecture: `ReverseImageProvider { search(imageRef) → {matches[], provenance, cost} }` ; implémentation locale par défaut ; providers cloud désactivés (§24) avec avertissement « l'image quitte la machine ».  

Decision: **DEFER**  
Reason: valeur dépendante d'un cas d'usage Investigator non encore posé ; coût + confidentialité ; le provider local (hash perceptuel) est suffisant pour démarrer.  
Prerequisites: Investigator (§15), Root Policy (UPLOAD OFF).  
Blockers: conditions d'utilisation non lues ; prix/quotas à reconfirmer.  
Open questions: politique de rétention TinEye ? usage personnel permis via l'API ?  

### 7.11 NAMECHK

Identity: Namechk — vérification de disponibilité de nom de domaine / de pseudo sur ~82 (jusqu'à 157) sites `[WEB-S]`. Service propriétaire.  
Official repository: aucun  
Official website: `namechk.com`  
Latest relevant state: UNKNOWN  
Platform: web  
Languages: —  

License: propriétaire ; **base de sites non copiable** (consigne de la mission)  
Mixed licensing: —  
Asset/data restrictions: conditions UNKNOWN (non lues)  

Primary functionality: disponibilité domaine + pseudo multi-plateformes.  

Network behavior: Namechk interroge de nombreux sites ; **comme fonctionnalité**, il implique du sondage massif.  
Cloud dependencies: oui  
Secrets: n/a  
Telemetry: UNKNOWN  

Shell/process execution: —  
Filesystem access: —  
Browser access: —  
MCP/plugins: —  

Strict Local: **CLOUD_REQUIRED** (toute vérification de disponibilité est distante par nature).  
Security findings: énumération agressive = risque d'abus/ban ; RDAP est le canal propre pour les domaines.  
Supply-chain findings: aucune.  
Plugin4Shell-like risk: NO  

Overlap with Docteur: **Sherlock Studio** couvre déjà les pseudos sur un jeu **épinglé et haché** (défaut 3 sites, max 30, 1 recherche à la fois, 3 départs/min, résultats `untrusted`) `[REPO]`.  

Possible integrations:  
1. Brand Presence = **RDAP** (disponibilité domaine) + **réutilisation de Sherlock** (pseudos).
2. Aucune API Namechk à intégrer.
3. Table de TLD/bootstrap IANA ; signalement `availabilityCheck` (brouillon IETF) `[WEB-S]`.

Recommended architecture: §8 (feature Brand Presence).  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: la fonction se reconstruit proprement avec RDAP + Sherlock ; rien à copier.  
Prerequisites: Web Egress Guard.  
Blockers: aucun.  
Open questions: valeur réelle (faible).  

### 7.12 COVER YOUR TRACKS

Identity: EFF Cover Your Tracks (ex-Panopticlick). 577 commits ; maintenu par William Budington (travail originel de Peter Eckersley) ; activité modeste `[WEB-P]`.  
Official repository: `https://github.com/EFForg/cover-your-tracks`  
Official website: `coveryourtracks.eff.org`  
Latest relevant state: Python/Flask, JS de fingerprinting, Parcel, **MySQL**, Docker  
Platform: serveur web + navigateur  
Languages: Python, JavaScript  

License: **AGPL-3.0** `[WEB-P]`  
Mixed licensing: UNKNOWN  
Asset/data restrictions: —  

Primary functionality: mesure de l'unicité de l'empreinte de navigateur + simulation de blocage de traqueurs.  

Network behavior: l'empreinte est **envoyée au serveur** et stockée (époques de 45 jours, IP hachée par HMAC) ; le test de blocage exige des domaines tiers (`trackersimulator.org`, `eviltracker.net`, …).  
Cloud dependencies: serveur (auto-hébergeable) + domaines tiers  
Secrets: mot de passe admin + keyfile  
Telemetry: stockage d'empreintes (par conception)  

Shell/process execution: —  
Filesystem access: —  
Browser access: collecte d'empreinte  
MCP/plugins: —  

Strict Local: **STRICT_LOCAL_PARTIAL** (auto-hébergé : OK ; le test de traqueurs reste distant).  
Security findings: collecte d'empreinte ⇒ ne jamais l'envoyer ailleurs sans consentement.  
Supply-chain findings: Pipenv/Docker/MySQL.  
Plugin4Shell-like risk: POSSIBLE (faible)  

Overlap with Docteur: partiel — Docteur a déjà un diagnostic de **sa propre confidentialité** (mode Strict Local, « Journal de confidentialité » des appels cloud bloqués, audit web Observateur/`cyber-detect-headers`) `[REPO]`.  

Possible integrations:  
1. Intégrer — non (AGPL + MySQL + domaines tiers).
2. Sidecar auto-hébergé — non (disproportionné).
3. **Diagnostic local** : un panneau qui explique cookies/en-têtes/configuration *du navigateur utilisé pour Docteur* sans rien envoyer (les détecteurs `cyber-detect-*` réutilisables).

Recommended architecture: «Privacy Diagnostic» = résultats locaux uniquement ; pas de collecte d'empreinte brute ; aucune requête vers des domaines de test.  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: valeur faible ; recouvrement avec Observateur/Strict Local ; AGPL.  
Prerequisites: —  
Blockers: AGPL pour toute reprise de code.  
Open questions: l'utilisateur veut-il vraiment ce diagnostic ?  

### 7.13 SCRAPLING

Identity: Scrapling (D4Vinci) — framework Python de scraping adaptatif. 84,9 k étoiles, 8,7 k forks, 1 628 commits ; très actif (92 % de couverture annoncée, Pyright/MyPy) `[WEB-P]`. **Attention** : le CVE-2026-81848 (SSRF, MEDIUM) concerne **`scrapling-fetch-mcp` de cyberchitta (≤ 0.2.2)**, un wrapper **tiers**, pas Scrapling lui-même `[WEB-S]`.  
Official repository: `https://github.com/D4Vinci/Scrapling`  
Official website: UNKNOWN  
Latest relevant state: Python ≥ 3.10 ; parseur, 4 fetchers, Spiders, serveur MCP, skill d'agent  
Platform: Windows implicite (non restreint)  
Languages: Python  

License: BSD-3-Clause `[WEB-P]`  
Mixed licensing: dépendances navigateur/empreinte (Playwright, Chromium, outils d'empreinte) : licences propres — UNKNOWN  
Asset/data restrictions: —  

Primary functionality: parseur CSS/XPath rapide avec **relocalisation adaptative** d'éléments ; `Fetcher` (HTTP avec usurpation d'empreinte TLS), **`StealthyFetcher` (« Bypass Cloudflare Turnstile out of the box »)**, `DynamicFetcher` (automatisation navigateur), Spiders (pause/reprise, AutoThrottle, robots.txt optionnel), rotation de proxies, **serveur MCP**, shell interactif, convertisseur curl.  

Network behavior: arbitraire ; proxies ; DNS-over-HTTPS optionnel.  
Cloud dependencies: aucune propre (selon cibles) ; `scrapling install` télécharge navigateurs + dépendances système + outils d'empreinte  
Secrets: proxies (identifiants)  
Telemetry: **non mentionnée** `[WEB-P]`  

Shell/process execution: shell interactif ; lancement de navigateurs ; MCP  
Filesystem access: sorties `.md/.txt/.html`, checkpoints de spiders  
Browser access: Playwright/Chromium piloté  
MCP/plugins: **oui** (serveur MCP « Secure-by-default HTTP transport » selon le README ; pages « nettoyées d'injection de prompt » = **déclaration non vérifiée**)  

Strict Local: **STRICT_LOCAL_PARTIAL** (le parseur seul est local ; tout le reste vise le web).  
Security findings: **« no SSRF protections explicitly mentioned »** ; fonctionnalités de contournement anti-bot (incompatibles avec la règle racine n°3) ; téléchargement de composants à l'installation.  
Supply-chain findings: `scrapling install`, Docker non épinglé, MCP.  
Plugin4Shell-like risk: POSSIBLE  

Overlap with Docteur: `deep-capture.js` (Playwright + Readability, 1 page, lecture seule, sans login) + `url-security.js` + `web-search.js` (DuckDuckGo HTML) `[REPO]`.  

Possible integrations:  
1. Intégrer la bibliothèque — non.
2. Sidecar Python — marginal, avec les risques ci-dessus.
3. **Reprendre l'idée du parsing adaptatif** (relocalisation d'éléments par similarité) pour fiabiliser `deep-capture`.

Recommended architecture: **Docteur Web Research Adapter** (§8.F) = allowlist de protocoles, interdiction des réseaux privés (avec résolution DNS), normalisation d'URL, redirections validées, téléchargements bornés, vérification MIME, aucun shell, aucune écriture fichier arbitraire, **contenu web = DATA** (marquage `UNTRUSTED_WEB`, jamais fusionné dans un prompt système).  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: l'essentiel utile (parsing) est petit ; le reste = stealth, contournement, MCP, téléchargements d'installation.  
Prerequisites: Web Egress Guard.  
Blockers: absence de garde SSRF documentée ; stealth.  
Open questions: besoin de crawl multi-pages ? sinon `deep-capture` suffit.  

### 7.14 OBSCURA

Identity: Obscura (h4ckf0r0day) — navigateur headless en Rust avec moteur **V8**, protocole **CDP**, pour agents et scraping ; « drop-in » pour Puppeteer/Playwright. 28,2 k étoiles, 2,1 k forks, 1 265 commits, **104 issues ouvertes** ; « Obscura Cloud » en développement `[WEB-P]`. Très récent, évolution rapide, stabilité UNKNOWN.  
Official repository: `https://github.com/h4ckf0r0day/obscura`  
Official website: UNKNOWN (wiki GitHub)  
Latest relevant state: crates `obscura-cli`, `obscura-worker` ; CDP sur **port 9222** ; Docker distroless (uid 65532) ; Windows `.zip`  
Platform: Windows (zip), Linux, macOS ; NixOS  
Languages: Rust (+ V8 compilé depuis les sources)  

License: Apache-2.0 `[WEB-P]` ; issue #1125 : `cargo deny check licenses` échoue (`jpeg-encoder`, licence IJG) → **la conformité des dépendances n'est pas nette**  
Mixed licensing: dépendances Rust variées  
Asset/data restrictions: —  

Primary functionality: exécution JS réelle, DOM partiel, CDP ; mode `--stealth` : randomisation d'empreinte (GPU, écran, canvas, audio, batterie), `navigator.webdriver` masqué, **événements `isTrusted = true`**, blocage de 3 520 domaines de traqueurs ; **serveur MCP (14 outils)** ; plugin « Hermes » tiers.  

Network behavior: WebSocket CDP 9222 ; proxy HTTP/SOCKS5 ; **refus des réseaux privés par défaut** (`--allow-private-network` pour les autoriser).  
Cloud dependencies: aucune obligatoire  
Secrets: proxies  
Telemetry: UNKNOWN  

Shell/process execution: processus `obscura-worker` ; budget d'exécution de script 30 s ; plafond de tas V8 réglable  
Filesystem access: répertoire de stockage, polices (`--font-dir`) ; pas de modèle allowlist/denylist FS  
Browser access: **c'est le navigateur**  
MCP/plugins: **oui**  

Strict Local: **STRICT_LOCAL_PARTIAL** (moteur local, mais prévu pour le web).  
Security findings (issues ouvertes `[WEB-P]`) : #1056 « SSRF gate skipped quand l'URL d'override d'interception ne se parse pas » ; #1053 « injection de cookie inter-IP » ; #1046 DoS CPU via `Set-Cookie` ; #1108 message d'erreur SSRF ; #1093 perte de données IndexedDB. **« No explicit sandboxing claims for JavaScript execution or process isolation »** (README).  
Supply-chain findings: binaires GitHub **sans checksum/signature identifiés** (UNKNOWN) ; `curl | tar` ; V8 compilé au build ; image Docker.  
Plugin4Shell-like risk: POSSIBLE  

Overlap with Docteur: Playwright/Chromium déjà dans `deep-capture.js` (single-page, read-only) `[REPO]`.  

Isolation réelle (analyse demandée) : **« sandbox V8 » ≠ sandbox OS.** V8 isole la *mémoire du script* de l'API hôte, pas le *processus* du système : une vulnérabilité du moteur ou un bug de l'embedding (CDP, réseau, FS) donne les droits du compte Windows. Options Windows à examiner si un sidecar est un jour retenu `[KNOW]` : (a) **AppContainer** (token à capacités limitées, accès réseau/FS nommés) ; (b) **Job Object** (limites mémoire/CPU/nombre de processus, `KILL_ON_JOB_CLOSE`) ; (c) **niveau d'intégrité bas** (écritures bloquées vers les objets de niveau moyen) ; (d) répertoire de travail jetable + ACL ; (e) filtrage réseau via WFP/pare-feu — **non automatisable ici** (interdit : modifier le pare-feu) ; (f) VM/Windows Sandbox (Pro/Enterprise : l'OS cible est **Windows 11 Home** `[REPO]` → non disponible). Node n'expose pas ces API : il faudrait un lanceur natif minimal (hors périmètre de cette mission).  

Possible integrations:  
1. Intégrer — non.
2. **Sidecar CDP** — seulement avec bac à sable OS réel + Web Egress Guard + sans stealth + sans MCP.
3. Reprendre : budgets d'exécution par script, refus de réseaux privés par défaut.

Recommended architecture: néant à ce stade.  

Decision: **DEFER**  
Reason: valeur marginale face à Playwright déjà présent ; risque élevé (projet jeune, issues SSRF/cookies ouvertes, stealth, pas d'isolation OS) ; prérequis (bac à sable Windows) absents.  
Prerequisites: Root Policy + lanceur confiné (AppContainer/Job Object) + Web Egress Guard + besoin démontré de crawl lourd.  
Blockers: isolation OS absente ; checksums UNKNOWN ; stealth.  
Open questions: une release signée existe-t-elle ? les issues #1053/#1056 sont-elles corrigées ?  

### 7.15 MEMOS

Identity: Memos (usememos) — notes auto-hébergées « markdown-first », timeline, tags, épingles. 63,5 k étoiles, 4 836 commits, 50 issues/45 PR ouvertes ; **versionnage calendaire (26.09.1)** `[WEB-P]`.  
Official repository: `https://github.com/usememos/memos`  
Official website: `usememos.com`  
Latest relevant state: Go + React, SQLite (MySQL/Postgres), proto/gRPC + REST, image Docker `stable`/`canary`, extension « Web Clipper » Chrome/Firefox  
Platform: Docker/binaire ; Windows UNKNOWN  
Languages: Go, TypeScript  

License: MIT `[WEB-P]`  
Mixed licensing: UNKNOWN  
Asset/data restrictions: —  

Primary functionality: capture rapide de notes, recherche plein texte via timeline/tags, partage privé/public, pièces jointes.  

Network behavior: serveur auto-hébergé ; « zero telemetry » déclaré.  
Cloud dependencies: aucune  
Secrets: jetons d'API/PAT (détails UNKNOWN)  
Telemetry: « zero telemetry » (déclaration)  

Shell/process execution: UNKNOWN  
Filesystem access: pièces jointes  
Browser access: Web Clipper (extension)  
MCP/plugins: webhooks UNKNOWN  

Strict Local: **STRICT_LOCAL_FULL (probable)** si auto-hébergé sans clipper.  
Security findings: second serveur web avec authentification propre = surface supplémentaire.  
Supply-chain findings: Docker `stable`/`canary` mutables.  
Plugin4Shell-like risk: POSSIBLE (faible)  

Overlap with Docteur: **très fort** — Notebook (documents, notes, FTS + RAG, citations, mémoire approuvée) + neurones + « À capturer (Todo) » + Capture `[REPO]`. Memos n'apporte **ni RAG, ni embeddings, ni provenance** ; son apport est l'ergonomie « flux de pensées horodaté ».  

Possible integrations:  
1. Intégrer — non (doublon).
2. Sidecar — non (deux systèmes de notes concurrents = exactement ce qu'il faut éviter).
3. Reprendre l'**idée de capture rapide horodatée** comme mode du Notebook/Capture (une zone de saisie persistante).

Recommended architecture: aucune nouvelle brique ; éventuelle amélioration UX de Capture dans une mission Notebook **ultérieure** (module gelé → nouvelle mission).  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: Memos n'apporte rien que Notebook n'ait, sinon l'UX de capture.  
Prerequisites: —  
Blockers: Notebook gelé.  
Open questions: la saisie rapide actuelle (Capture/Todo) frustre-t-elle l'utilisateur ?  

### 7.16 CHATWOOT

Identity: Chatwoot — plateforme de support client omnicanal (live chat, email, réseaux sociaux, WhatsApp/Telegram/SMS). 37,4 k étoiles, 9,1 k forks `[WEB-P]`.  
Official repository: `https://github.com/chatwoot/chatwoot`  
Official website: `chatwoot.com`  
Latest relevant state: Rails + Vue + PostgreSQL + Redis + Sidekiq ; Docker, Heroku, K8s ; agent IA « Captain »  
Platform: Linux/Docker (Windows : UNKNOWN, WSL/Docker seulement)  
Languages: Ruby, JavaScript  

License: MIT (racine) `[WEB-P]`  
Mixed licensing: **dossier `enterprise/` sous licence séparée** (termes UNKNOWN)  
Asset/data restrictions: fonctions enterprise/cloud  

Primary functionality: boîte de réception partagée, contacts, conversations, API + webhooks, automatisations, Captain.  

Network behavior: **phone-home vers `hub.chatwoot.com` / `hub.2.chatwoot.com` quotidiennement** ; désactivable (`DISABLE_TELEMETRY=true`) `[WEB-S]` ; canaux entrants exigent des webhooks **publics**.  
Cloud dependencies: services de messagerie par canal  
Secrets: jetons de chaque canal, SMTP, clés d'API  
Telemetry: ChatwootHub (désactivable)  

Shell/process execution: Sidekiq/Rails  
Filesystem access: pièces jointes (Active Storage)  
Browser access: widget de chat  
MCP/plugins: webhooks, intégrations  

Strict Local: **CLOUD_REQUIRED en pratique** (canaux externes ; entrées publiques).  
Security findings `[WEB-S]` (2026) : **CVE-2026-5205 (SSRF dans l'API Webhook, ≤ 4.11.2)** ; **CVE-2026-44707 (pre-account takeover, 2.14.0 → 4.12.x)** ; **CVE-2026-44706 (injection SQL filtres, 2.2.0 → < 4.11.2)** ; **CVE-2026-4990 (inscription, ≤ 4.11.1)** ; **CVE-2026-63765 (contournement d'auth des direct uploads, < 4.16.0)** → historique de vulnérabilités chargé pour une application exposée.  
Supply-chain findings: gems Ruby, images Docker.  
Plugin4Shell-like risk: POSSIBLE  

Overlap with Docteur: Sales Studio (brouillon, jamais envoyé), connecteurs OAuth `[REPO]` ; **pas** de boîte de réception.  

Possible integrations:  
1. Intégrer — non.
2. Sidecar Docker — disproportionné pour un usage mono-utilisateur, expose une surface Internet.
3. Reprendre le **modèle conversation/contact/statut** pour un futur « Support Helper » local.

Recommended architecture: Agency §16 : `RESEARCH → ANALYZE → SCORE → DRAFT → HUMAN REVIEW → EXPLICIT SEND` ; **jamais de réponse automatique à un client**.  

Decision: **DEFER**  
Reason: pas de besoin support client démontré ; stack lourde (Rails/PG/Redis/Sidekiq) et historique CVE ; contraire au Strict Local.  
Prerequisites: besoin réel de boîte support ; Root Policy ; plan d'exposition réseau.  
Blockers: Windows Home (Docker/WSL), CVE, phone-home.  
Open questions: l'utilisateur a-t-il des clients à servir ? canaux visés ?  

### 7.17 POSTIZ

Identity: Postiz (gitroomhq) — planificateur/publication multi-réseaux (Instagram, YouTube, TikTok, LinkedIn, X, Facebook, Pinterest, Reddit, Threads, Dribbble, Slack, Discord, Mastodon, Bluesky). Version cloud SaaS + auto-hébergée `[WEB-P]`.  
Official repository: `https://github.com/gitroomhq/postiz-app`  
Official website: `postiz.com`  
Latest relevant state: NestJS + Next.js + Prisma/PostgreSQL + **Temporal** + Resend ; pnpm monorepo ; Docker ; SDK Node, n8n/Make ; **MCP/CLI/agent** pour auto-hébergé  
Platform: Docker/VPS ; Windows UNKNOWN  
Languages: TypeScript  

License: **AGPL-3.0** `[WEB-P]`  
Mixed licensing: UNKNOWN (marque/enterprise : UNKNOWN)  
Asset/data restrictions: —  

Primary functionality: planifier et publier, génération IA (clés fournies par l'utilisateur), API publique.  

Network behavior: OAuth direct avec chaque plateforme (« n'enregistre ni ne proxifie les clés API » selon le projet) ; l'auto-hébergement exige **la création d'une application développeur par réseau**.  
Cloud dependencies: toutes les plateformes sociales  
Secrets: **jetons OAuth/refresh de chaque réseau** (stockés dans PostgreSQL de l'instance)  
Telemetry: UNKNOWN  

Shell/process execution: workers Temporal  
Filesystem access: médias  
Browser access: —  
MCP/plugins: **MCP/CLI** (surface d'agent autonome)  

Strict Local: **CLOUD_REQUIRED** (publication = par nature externe).  
Security findings: détient des jetons de publication (compromission = publication en votre nom) ; MCP/agents = risque d'autonomie ; AGPL.  
Supply-chain findings: pnpm monorepo, Docker, Temporal.  
Plugin4Shell-like risk: POSSIBLE  

Overlap with Docteur: Sales Studio (brouillons) ; aucun éditeur/planificateur de publication `[REPO]`.  

Possible integrations:  
1. Intégrer — non (AGPL, jetons).
2. Sidecar auto-hébergé — possible plus tard **si** publication régulière, jetons dans l'instance isolée, aucun MCP activé.
3. Reprendre le modèle `DRAFT → REVIEW → SCHEDULE → PUBLISH`.

Recommended architecture: Agency produit des **brouillons** ; la publication est une action séparée, **explicite, à usage unique, approuvée** (§16).  

Decision: **DEFER**  
Reason: aucune valeur tant que la production de contenu n'est pas régulière ; surface de jetons/AGPL/MCP ; Root Policy requise d'abord.  
Prerequisites: Root Policy, magasin de secrets par module, plan de publication réel.  
Blockers: AGPL, jetons.  
Open questions: quels réseaux, quelle fréquence ?  

### 7.18 GETHUMAN

Identity: GetHuman — service gratuit financé par la publicité : numéros/chemins pour joindre un humain, programmation d'appels, **navigation automatique des menus téléphoniques par IA** (Gemini), aide à la rédaction d'e-mails/tweets `[WEB-P]`.  
Official repository: aucun  
Official website: `gethuman.com`  
Latest relevant state: service actif  
Platform: web  
Languages: —  

License: propriétaire ; contenu rédigé par des chercheurs humains (**base non copiable**)  
Mixed licensing: —  
Asset/data restrictions: API et règles de réutilisation : **non documentées** dans ce que j'ai lu (UNKNOWN)  

Primary functionality: annuaire de contacts support + outils d'appel assisté.  

Network behavior: service distant  
Cloud dependencies: oui  
Secrets: n/a  
Telemetry: publicité/analytics (UNKNOWN)  

Shell/process execution: —  
Filesystem access: —  
Browser access: —  
MCP/plugins: —  

Strict Local: **CLOUD_REQUIRED**.  
Security findings: aucune pour Docteur tant qu'on ne l'intègre pas ; la téléphonie automatisée = fonction d'autrui à fort impact.  
Supply-chain findings: aucune.  
Plugin4Shell-like risk: NO  

Overlap with Docteur: Todo/notes/Notebook pour des « procédures personnelles » `[REPO]`.  

Possible integrations:  
1. Aucune.
2. **Support Helper local** : liens officiels saisis par l'utilisateur, numéros officiels, minuteurs, notes de procédure (Notebook).
3. Idée de « meilleur moment pour appeler » (heuristique locale).

Recommended architecture: pas de module : un **modèle de notes** dans Notebook. Toute téléphonie automatisée = mission séparée avec consentement explicite (hors périmètre).  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: pas de base à copier ; le besoin se couvre avec les notes.  
Prerequisites: —  
Blockers: —  
Open questions: besoin récurrent ?  

### 7.19 SHOW ME THE MONEY

Identity: Show Me The Money (iamzifei) — suite de **25 skills** pour agents (Claude Code, Codex CLI, Gemini CLI, Cursor) censée « construire et exploiter une entreprise 24/7 » : découverte, stratégie, produit, contenu, outreach, social, SEO, **Ads (Google/Meta)**, finance (Stripe), ops. v2.8.0 ; 1 000+ étoiles, 158 forks ; paquet npm `@orrisai/show-me-the-money` publié le 2026-07-17, 15 versions `[WEB-P]`.  
Official repository: `https://github.com/iamzifei/show-me-the-money`  
Official website: marque « orris.ai » (mainteneur npm : `james_orris`, `support@orris.ai`)  
Latest relevant state: marketplace `claude plugin marketplace add iamzifei/show-me-the-money` **ou** `npx @orrisai/show-me-the-money`  
Platform: agents CLI  
Languages: Node.js + Markdown (skills)  

License: **CC BY-NC 4.0** (passée depuis MIT en v2.2.0) ; usage commercial/OEM = licence séparée (`COMMERCIAL-LICENSE.md`)  
Mixed licensing: **CC n'est pas une licence logicielle** (déconseillée par Creative Commons pour du code) ; non-commercial = incompatible avec tout usage commercial de Docteur  
Asset/data restrictions: —  

Primary functionality: skills = **instructions** chargées dans le contexte de l'agent ; état local `~/.smtm/` (sessions JSONL/markdown, rapports) ; reviewers « Investor/Customer/Operator/Skeptic » ; `/money-ops` « 24/7 » avec « panic stop ».  

Network behavior: déclaré : « seul appel réseau = `npm view` silencieux » ; mais `/money-upgrade` **télécharge et remplace** les skills ; les skills Ads/Social/Outreach pilotent des plateformes externes.  
Cloud dependencies: Google Ads, Meta Ads, X, LinkedIn, Reddit, Stripe, API d'images  
Secrets: clés des plateformes (gérées par l'utilisateur, « jamais stockées par la suite » — déclaration)  
Telemetry: aucune déclarée en dehors de la vérification de version  

Shell/process execution: **les skills pilotent l'agent** (qui a Bash) ; `install.js` en `postinstall`  
Filesystem access: `~/.claude/skills/`, `~/.smtm/` ; `install.js` fait `fs.rmSync(dest, {recursive, force})` puis copie (lu sur `master`)  
Browser access: —  
MCP/plugins: marketplace de plugins ; pas de MCP déclaré  

Strict Local: **CLOUD_REQUIRED** pour la plupart des fonctions utiles (Ads/Social/Stripe).  
Security findings: (1) les skills sont des **instructions privilégiées** : un `/money-upgrade` malveillant = injection de prompt persistante dans l'agent qui édite Docteur ; (2) skills d'actions externes (publier, dépenser en publicité) en contradiction avec « aucun envoi/publication autonome » ; (3) licence NC.  
Supply-chain findings: `postinstall: node install.js` ; mise à jour par npm sans signature ; **scope npm (`@orrisai`) ≠ propriétaire du dépôt (`iamzifei`)** → lien de propriété non démontré (le champ `repository` pointe bien vers le dépôt) ; lecture de `install.js` sur `master` **≠** vérification du tarball npm (UNKNOWN : non comparés).  
**Plugin4Shell-like risk: YES** (classe : mise à jour non vérifiée de code/instructions exécutés avec l'autorité de l'agent ; pas le bug git exact).  

Overlap with Docteur: Sales Studio (recherche→score→brouillon, jamais envoyé), Investment Studio (analyse, paper trading), Compétences (Skills) interne, Mémoire `[REPO]`.  

Valeur réelle pour Docteur : **faible-moyenne, et reproductible** : les idées utiles (checkpoint/restore d'état, panels de relecture « sceptique / client / opérateur », rapports horodatés append-only) sont de simples **modèles de prompt** + du stockage local, que Docteur sait déjà faire (bibliothèque de prompts + Notebook + Agents). Les données financières touchées par le projet sont celles de **plateformes publicitaires/Stripe de l'utilisateur** — Docteur n'a et ne doit avoir aucune clé de ce type (« aucun broker réel », Investment Studio).  

Possible integrations:  
1. Installer le plugin — **non**.
2. Lire les prompts dans un bac à sable sans les exécuter, pour s'inspirer — acceptable (lecture seule).
3. Recréer 2-3 modèles de prompt natifs (revue multi-points de vue, checkpoint) dans la bibliothèque existante.

Recommended architecture: néant (idées → modèles de prompt de Docteur, texte original, sans reprise de contenu CC BY-NC).  

Decision: **REJECT**  
Reason: licence NC + risque d'update non vérifié + autonomie externe (Ads/Stripe/social) opposée aux règles Docteur ; l'idée utile se reproduit sans le projet.  
Prerequisites: —  
Blockers: licence, Plugin4Shell-like YES.  
Open questions: le tarball npm 2.8.0 est-il identique à `master` ? (non requis si rejeté).  

### 7.20 PDF24

Identity: PDF24 / PDF24 Creator (Geek Software GmbH) — suite PDF gratuite : fusion, découpe, compression, rotation, images↔PDF, extraction, OCR, filigrane, numérotation, comparaison, protection, déverrouillage, caviardage, conversion, signature ; version en ligne et version Windows `[WEB-S]`.  
Official repository: aucun (propriétaire)  
Official website: `pdf24.org`  
Latest relevant state: logiciel gratuit maintenu ; version Windows « Creator »  
Platform: Windows (desktop) + web  
Languages: UNKNOWN  

License: **freeware propriétaire** ; « l'usage séparé des composants **n'est pas permis**, à l'exception de la version GPL de Ghostscript incluse » `[WEB-S]`  
Mixed licensing: Ghostscript **(A)GPL** en instance privée appelée en CLI (« agrégat »)  
Asset/data restrictions: —  

Primary functionality: voir ci-dessus.  

Network behavior: version en ligne : **upload de fichiers vers PDF24** ; Creator : updater propre (UNKNOWN)  
Cloud dependencies: web = oui ; Creator = non pour les fonctions de base (UNKNOWN pour OCR/conversion)  
Secrets: —  
Telemetry: UNKNOWN  

Shell/process execution: Ghostscript en sous-processus  
Filesystem access: fichiers de l'utilisateur  
Browser access: —  
MCP/plugins: —  

Strict Local: version Creator = **STRICT_LOCAL_PARTIAL (UNKNOWN précisément)** ; version web = **CLOUD_REQUIRED**.  
Security findings: PDF malveillants (parseurs) ; **caviardage** : un faux caviardage (cacher sans supprimer) est un risque de confidentialité majeur.  
Supply-chain findings: installeur propriétaire + updater ; non embarquable.  
Plugin4Shell-like risk: POSSIBLE  

Overlap with Docteur: `pdf.js` (Playwright → rendu), `pdf-parse` (extraction de texte), tesseract.js (OCR image côté frontend), `exceljs` `[REPO]` ; **aucune** boîte à outils PDF d'édition.  

Possible integrations (par fonction, §8.G) : bibliothèques permissives et CLI (qpdf, pdf-lib, pdfcpu, PDFium, Tesseract/OCRmyPDF, Ghostscript en dernier recours AGPL isolé).  

Recommended architecture: **Docteur Document Toolbox**, STRICT LOCAL, §8.G.  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: non embarquable ; la liste de fonctions est une bonne checklist ; l'implémentation se fait avec des composants permissifs.  
Prerequisites: Root Policy (écriture bornée) ; épinglage des outils.  
Blockers: licence PDF24 ; caviardage sûr = difficile.  
Open questions: quelles fonctions réellement utiles (fusion/découpe/OCR d'abord) ?  

### 7.21 ISTHEREANYDEAL

Identity: IsThereAnyDeal (ITAD) — historique de prix et alertes pour jeux PC ; **API officielle** documentée (`docs.isthereanydeal.com`) `[WEB-P]`.  
Official repository: UNKNOWN  
Official website: `isthereanydeal.com` ; apps : `isthereanydeal.com/apps/my/`  
Latest relevant state: API v1/v2/v3 selon endpoint  
Platform: API HTTP  
Languages: —  

License: **conditions d'API** : usage commercial autorisé *si l'application est publique* ; usage personnel privé autorisé ; **interdits** : suggérer une affiliation, retirer les tags d'affiliation ou altérer les données, créer des applications concurrentes ; attribution recommandée.  
Mixed licensing: —  
Asset/data restrictions: conditions ci-dessus  

Primary functionality: prix actuels (`/games/prices/v3`), historique (`/games/historylow/v1`, `/games/history/v2`), wishlist/collection (OAuth2 + PKCE).  

Network behavior: clé API (`key` ou en-tête `ITAD-API-Key`) ; **1 000 requêtes / 5 min** (compte vérifié) ; 429 + `Retry-After` ; « contourner les limites peut entraîner un bannissement ».  
Cloud dependencies: **requis**  
Secrets: clé API ; jetons OAuth pour wishlist  
Telemetry: n/a  

Shell/process execution: aucun  
Filesystem access: aucun  
Browser access: —  
MCP/plugins: —  

Strict Local: **CLOUD_REQUIRED**.  
Security findings: clé API à stocker en DPAPI ; liens d'affiliation à ne pas altérer.  
Supply-chain findings: aucune.  
Plugin4Shell-like risk: NO  

Overlap with Docteur: aucun (`radio-catalog`, Kiwix = autres sujets).  

Possible integrations:  
1. Module « Game Price Watch » isolé, pull-only, manuel.
2. —
3. —

Recommended architecture: module optionnel hors chemin critique : une clé en DPAPI, cache local, aucune écriture hors de son dossier ; désactivé par défaut (EXTERNAL API OFF).  

Decision: **DEFER**  
Reason: valeur faible pour un assistant ; fonctionne mais n'est pas une priorité ; garde les conditions d'affiliation à respecter.  
Prerequisites: Root Policy (permission réseau par module).  
Blockers: aucun technique.  
Open questions: usage réel (liste de souhaits ?).  

### 7.22 MYFRIDGEFOOD

Identity: MyFridgeFood — recherche de recettes par ingrédients ; apps iOS/Android ; recettes soumises par les utilisateurs ; page « Copyright Policy » `[WEB-P]`.  
Official repository: aucun  
Official website: `myfridgefood.com`  
Latest relevant state: UNKNOWN  
Platform: web + mobile  
Languages: —  

License: contenu propriétaire/soumis par les utilisateurs — **non copiable**  
Mixed licensing: —  
Asset/data restrictions: droits d'auteur sur les recettes/photos  

Primary functionality: ingrédients → recettes.  

Network behavior: service distant ; API : non documentée  
Cloud dependencies: oui  
Secrets: —  
Telemetry: UNKNOWN (publicités/trackers non vérifiés)  

Shell/process execution: —  
Filesystem access: —  
Browser access: —  
MCP/plugins: —  

Strict Local: **CLOUD_REQUIRED** (le service) ; **idée réalisable en STRICT_LOCAL_FULL** avec des recettes locales.  
Security findings: aucune pour Docteur.  
Supply-chain findings: aucune.  
Plugin4Shell-like risk: NO  

Overlap with Docteur: aucun module culinaire ; ce serait une application de niche. Notebook + LLM local couvrent déjà « que cuisiner avec X, Y » sans module.  

Possible integrations:  
1. —
2. —
3. Un **modèle de prompt** (« garde-manger ») dans la bibliothèque de prompts existante.

Recommended architecture: aucune.  

Decision: **REJECT** (comme module)  
Reason: scope creep : valeur faible, aucun recoupement avec la mission de Docteur, coût de maintenance d'un domaine entier.  
Prerequisites: —  
Blockers: —  
Open questions: —  

### 7.23 FILEPIZZA

Identity: FilePizza (kern) — transfert de fichiers **pair à pair par WebRTC** dans le navigateur ; v2 « sans WebTorrent » `[WEB-P]`.  
Official repository: `https://github.com/kern/filepizza`  
Official website: `file.pizza`  
Latest relevant state: Next.js, TypeScript, React, **PeerJS**, Tailwind ; Redis optionnel ; Docker  
Platform: navigateurs  
Languages: TypeScript  

License: **BSD-3-Clause** `[WEB-P]`  
Mixed licensing: UNKNOWN  
Asset/data restrictions: —  

Primary functionality: l'envoyeur ouvre une page ; le destinataire se connecte ; transfert direct chiffré **DTLS** ; mot de passe optionnel ; plusieurs fichiers → zip ; streaming par Service Worker.  

Network behavior: **STUN par défaut `stun:stun.l.google.com:19302`** ; **signalisation par défaut = PeerJS cloud `0.peerjs.com`** (auto-hébergeable via `PEERJS_HOST`) ; TURN activable (`COTURN_ENABLED`, `TURN_HOST`, `TURN_REALM`).  
Cloud dependencies: signalisation PeerJS + STUN Google **par défaut** ; self-host possible  
Secrets: mot de passe de partage ; identifiants TURN  
Telemetry: non mentionnée  

Shell/process execution: —  
Filesystem access: navigateur (téléchargement)  
Browser access: WebRTC  
MCP/plugins: —  

Strict Local: **STRICT_LOCAL_PARTIAL** — LAN-only est possible en pratique (candidats ICE « host » sans STUN, signalisation locale) mais « pas explicitement documenté » ; la config par défaut contacte Google et PeerJS.  
Security findings: dans une page publique, les métadonnées de session passent par le serveur de signalisation ; limites de taille dépendantes du navigateur.  
Supply-chain findings: dépendances Next.js ; runtime : services tiers par défaut.  
Plugin4Shell-like risk: POSSIBLE (faible)  

Overlap with Docteur: aucun transfert `[REPO]`. Device Fabric = inventaire/liaison d'appareils (autre domaine de confiance).  

Possible integrations:  
1. Intégrer FilePizza — non.
2. Sidecar PeerJS auto-hébergé + sans STUN/TURN — **possible mais plus complexe qu'un serveur HTTPS local** pour un usage LAN.
3. Reprendre : mot de passe de session, DTLS-like (TLS), streaming, zip.

Recommended architecture: **QR Transfer natif** sur HTTPS local (§11). WebRTC seulement si un jour transfert **hors LAN** (alors : Strict Local OFF explicite, TURN auto-hébergé, DEFER).  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: en LAN, WebRTC ajoute signalisation + ICE sans bénéfice ; en Internet il sort du Strict Local.  
Prerequisites: —  
Blockers: STUN/signalisation par défaut tiers.  
Open questions: besoin de transfert hors LAN ?  

### 7.24 QRCP (ajout : référence de la mission §13)

Identity: qrcp (claudiodangelis) — envoie/reçoit des fichiers via un **serveur HTTP temporaire** et un **QR code** ; 291 commits ; mainteneur actif (canaux Telegram/Twitter) `[WEB-P]`.  
Official repository: `https://github.com/claudiodangelis/qrcp`  
Official website: UNKNOWN  
Latest relevant state: Go ≥ 1.18 ; binaire unique  
Platform: Windows (binaire/gestionnaires de paquets), macOS, Linux  
Languages: Go  

License: MIT `[WEB-P]`  
Mixed licensing: UNKNOWN  
Asset/data restrictions: —  

Primary functionality: lie un serveur à l'interface Wi-Fi, **port aléatoire**, QR = `http://{adresse}:{port}/{chemin_aléatoire}` ; modes envoi/réception ; `-i` pour l'interface (`any` = `0.0.0.0`) ; `--tls-cert/--tls-key` ; s'arrête après transfert (sauf `--keep-alive`).  

Network behavior: LAN seulement  
Cloud dependencies: aucune  
Secrets: —  
Telemetry: UNKNOWN  

Shell/process execution: —  
Filesystem access: fichiers désignés ; réception vers un dossier  
Browser access: navigateur du téléphone  
MCP/plugins: —  

Strict Local: **STRICT_LOCAL_FULL**.  
Security findings: **aucune authentification documentée** ; seul le chemin aléatoire protège (obscurité) ; HTTP clair par défaut ; limites d'upload non spécifiées ; modèle de menace non documenté.  
Supply-chain findings: binaire Go ; vérification de release non documentée.  
Plugin4Shell-like risk: POSSIBLE (faible)  

Overlap with Docteur: aucun.  

Possible integrations:  
1. Lancer qrcp comme sidecar — **non** (pas d'auth, pas de jeton à usage unique, HTTP clair).
2. —
3. Reprendre : interface choisie, port aléatoire, extinction après transfert, QR avec URL.

Recommended architecture: §11.  

Decision: **ADAPT_IDEAS_ONLY**  
Reason: bonnes idées, mais garanties de sécurité insuffisantes (pas de jeton éphémère, pas de TLS par défaut) pour les exigences du §13 du prompt.  
Prerequisites: —  
Blockers: —  
Open questions: —  

---

## 8. Internal feature audits

Décisions possibles : BUILD_NATIVE / CONNECT_EXISTING / AUDIT_FURTHER / DEFER / REJECT. Phases : voir §25 (P0…P11).

### 8.A ROOT POLICY V1
Problem solved: aujourd'hui **au moins onze politiques verticales** (`maitre-policy`, `external-agent-policy`, `sherlock-policy`, `metagpt-policy`, `cyber-policy`, `sales-policy`, `kiwix-policy`, `openmontage-policy`, `local-api-policy`, `strict-local`, `privacy-guard`) et **aucune primitive d'approbation commune** `[REPO]` ; un nouveau module doit ré-inventer ses garde-fous.
Existing overlap: partiel (ci-dessus). `local-request-guard` protège **qui appelle l'API**, pas **ce que fait un exécuteur**.
Proposed architecture: §12.
Trust boundary: Root Policy = domaine de confiance propre ; ni OMEGA, ni RASSILON, ni Device Fabric, ni un LLM ne peuvent la modifier.
Required permissions: lecture seule pour les modules ; écriture = procédure humaine locale hors-application.
Local/cloud behavior: 100 % local.
Security risks: devenir un SPOF (fail closed → blocage), fausse impression de couverture (les 168 routes gelées ne l'appellent pas), contournement par un exécuteur qui n'appelle pas `enforce()`.
Privacy: journal d'audit sans contenu (hôtes, identifiants, décisions).
Failure behavior: **fail closed** pour toute opération protégée ; mode « lecture seule » dégradé.
Tests required: tests de décision (matrice), test statique « aucun exécuteur n'appelle `child_process`/`fetch` sans passer par `enforce()` » (modèle `test-device-fabric-static-audit.mjs`), altération du fichier de politique, rollback de version, STOP prioritaire.
Dependencies: aucune (peut précéder tous les autres).
Decision: **BUILD_NATIVE**
Recommended phase: **P1**

### 8.B RUNTIME SUPERVISOR
Problem solved: relancer Cortex/Ollama/worker sans fenêtre `cmd`, sans commande libre ; aujourd'hui `.bat` + `cmd /k` avec chemins en dur.
Existing overlap: `port-preflight.js`, `process-tree.js` (kill d'un arbre *spawné par Docteur*), MAÎTRE (arrêt de processus **arbitraires** par PID — autre périmètre) `[REPO]`.
Proposed architecture: §13.
Trust boundary: le superviseur est un **processus parent séparé** (Cortex ne peut pas se relancer lui-même).
Required permissions: spawn d'une liste fermée d'exécutables épinglés.
Local/cloud behavior: local.
Security risks: injection d'arguments, chemins contrôlés, boucles de redémarrage, élévation involontaire.
Privacy: logs sans données utilisateur.
Failure behavior: états `UNKNOWN`/`DEGRADED` explicites ; jamais de relance infinie.
Tests required: crash simulé, backoff, arrêt gracieux puis forcé, PID réutilisé, dépendances, absence d'API `exec(string)` (test statique).
Dependencies: Root Policy.
Decision: **BUILD_NATIVE**
Recommended phase: **P2**

### 8.C AI HISTORY / MEMORY IMPORT
Problem solved: contexte utilisateur à partir d'exports ChatGPT/Claude/Gemini.
Existing overlap: **déjà implémenté** (NB-4→NB-7) `[REPO]`.
Proposed architecture: §10 — pas de nouveau module.
Trust boundary: tout texte importé = DATA ; rôle→confiance (`USER_AUTHORED`, `PAST_AI_OUTPUT`, `TOOL_RESULT`) ; jamais `PRIMARY_SOURCE`.
Required permissions: choix explicite de l'utilisateur (opt-in) ; fichier fourni par lui.
Local/cloud behavior: local ; 0 appel réseau prouvé (spy NB-7).
Security risks: injection historique, mémoire empoisonnée, secrets/PII dans l'historique.
Privacy: stockage non chiffré au repos ; **pas de détection de PII**.
Failure behavior: schéma inconnu ⇒ rapporté, jamais deviné.
Tests required: **exports réels** (NOT_RUN), PII, corpus empoisonné réel.
Dependencies: Notebook gelé.
Decision: **CONNECT_EXISTING** (+ AUDIT_FURTHER pour la validation réelle et la PII)
Recommended phase: **P3** (validation seulement)

### 8.D BROWSER MEDIA BRIDGE
Problem solved: envoyer à Docteur, par action explicite, une URL média accessible à l'utilisateur ; téléchargement/progression/annulation locaux.
Existing overlap: `ytdlp.js`, `video-audio-download.js`, `youtube-discovery.js`, jobs (`jobs.js`) `[REPO]` ; **aucune extension/Native Messaging**.
Proposed architecture: §9.
Trust boundary: extension (non fiable, dans le navigateur) → Native Messaging → hôte natif minimal → moteur de téléchargement Docteur.
Required permissions: `nativeMessaging` + `activeTab` (pas d'hôte large) ; DOWNLOAD = ACTION UTILISATEUR.
Local/cloud behavior: téléchargement = réseau externe vers le site source (inévitable) ; aucune donnée vers un service tiers autre que la source.
Security risks: extension compromise, URL hostile, injection d'arguments yt-dlp, SSRF, écriture hors dossier de sortie.
Privacy: pas de cookies, pas d'historique de navigation.
Failure behavior: hôte absent ⇒ l'extension affiche « Docteur non disponible », rien n'est mis en file.
Tests required: schéma, tailles, timeouts, taux, URL hostiles, extension ID erronée, hôte tué.
Dependencies: Web Egress Guard (P0), Root Policy (P1), code de l'extension (UNKNOWN).
Decision: **BUILD_NATIVE** (conditionné à la fourniture de l'extension)
Recommended phase: **P5**

### 8.E QR FILE TRANSFER
Problem solved: PC↔téléphone sans câble ni cloud.
Existing overlap: aucun ; mode LAN HTTPS déjà exigé (`server.js`).
Proposed architecture: §11.
Trust boundary: domaine **Transfer** distinct ; aucune permission héritée de DF/OMEGA/RASSILON.
Required permissions: TRANSFER = ACTION UTILISATEUR ; ouverture de port **éphémère**.
Local/cloud behavior: 100 % LAN.
Security risks: jeton volé (photo du QR), balayage LAN, binding public accidentel, fichier malveillant, disque plein.
Privacy: noms de fichiers, hash.
Failure behavior: session détruite à l'échec/expiration ; fichier partiel supprimé.
Tests required: §11.8.
Dependencies: Root Policy ; certificat TLS dédié.
Decision: **BUILD_NATIVE**
Recommended phase: **P6**

### 8.F WEB RESEARCH ADAPTER (+ Web Egress Guard)
Problem solved: lecture de pages web par Docteur sans SSRF, sans fuite, sans injection.
Existing overlap: `web-search.js`, `deep-capture.js`, `web-explore`, `web-answer`, `url-security.js` (insuffisant, §1.4) `[REPO]`.
Proposed architecture: §5.4 + marquage `UNTRUSTED_WEB`.
Trust boundary: tout contenu web = DATA.
Required permissions: EXTERNAL API/lecture web = OFF par défaut hors action utilisateur.
Local/cloud behavior: sortant par nature ; Strict Local = refus (fail closed) sauf mode explicitement permis.
Security risks: SSRF/rebinding/redirects, taille, MIME, injection de prompt indirecte, téléchargements.
Privacy: URL = métadonnée sensible (journal sans chemin/paramètres).
Failure behavior: refus avec code stable.
Tests required: corpus SSRF, redirections, gros fichiers, MIME mensonger, injection dans la page.
Dependencies: aucune.
Decision: **BUILD_NATIVE** (durcir l'existant ; pas de nouveau scraper)
Recommended phase: **P0**

### 8.G DOCUMENT TOOLBOX (PDF)
Problem solved: opérations PDF locales, sans envoyer de document à un site.
Existing overlap: `pdf.js` (Playwright, rendu), `pdf-parse`, tesseract.js (frontend) `[REPO]` ; pas d'édition PDF.
Proposed architecture (stratégie par fonction `[KNOW]`, **à reconfirmer au moment du pin**) :

| Fonction | Stratégie recommandée | Licence (à relire) | Risque |
|---|---|---|---|
| Fusion / découpe / extraction de pages / rotation | **qpdf** (CLI, Apache-2.0) ou **pdf-lib** (JS, MIT) | permissive | faible |
| Images → PDF | pdf-lib (embedding PNG/JPEG) | MIT | faible |
| PDF → images | PDFium (BSD/Apache) / pdf.js (Apache-2.0) (rendu déjà présent) | permissive | faible |
| Numérotation / filigrane / overlay | pdf-lib | MIT | faible |
| Compression | qpdf (recompression de flux) ; Ghostscript = **AGPL** → sidecar isolé en dernier recours | AGPL pour GS | moyen |
| OCR | Tesseract (Apache-2.0) / OCRmyPDF (MPL-2.0) en local | permissive | moyen (parseurs) |
| Comparaison | diff de texte extrait (natif) | — | faible |
| Protection par mot de passe / déverrouillage | qpdf (chiffrement AES-256) — **déverrouiller uniquement avec le mot de passe fourni**, jamais de cassage | Apache-2.0 | faible/éthique |
| Caviardage | **DEFER** : un vrai caviardage doit supprimer le contenu sous-jacent (pas un rectangle noir) ; MuPDF = AGPL | — | **élevé** (faux caviardage) |
| Signature | **DEFER** (PKI, horodatage, certificats) | — | élevé |
| Conversion Office↔PDF | **DEFER** (LibreOffice = lourd, MPL/LGPL) | — | moyen |

Trust boundary: les PDF sont **non fiables** (parseurs, JS embarqué, pièces jointes) ; traitement dans un dossier de travail jetable, désactiver l'exécution de JS PDF, limites de taille/pages/temps.
Required permissions: écriture dans un dossier de sortie dédié ; aucun réseau.
Local/cloud behavior: **STRICT LOCAL** par défaut (test réseau bloqué).
Security risks: PDF malveillant, ZIP-bomb-like (pages géantes), fichiers écrasés, chemins.
Privacy: documents sensibles : pas de logs de contenu ; nettoyage du dossier jetable.
Failure behavior: échec = aucun fichier de sortie partiel.
Tests required: PDF corrompus/hostiles (fixtures), limites, idempotence, aucune écriture hors dossier, test réseau.
Dependencies: Root Policy ; épinglage des outils.
Decision: **BUILD_NATIVE** (fonctions faciles d'abord ; caviardage/signature DEFER)
Recommended phase: **P4**

### 8.H CODE INTELLIGENCE
Problem solved: comprendre le code sans terminal générique.
Existing overlap: **déjà livré en lecture seule** (ripgrep `shell:false`, workspace borné, `.gitignore`, git `status/diff/log/show`) `[REPO]`.
Proposed architecture: §17.
Decision: **CONNECT_EXISTING** (+ AUDIT_FURTHER pour tree-sitter/blame)
Recommended phase: hors roadmap principale (améliorations ultérieures).

### 8.I AGENCY AGENTS
Problem solved: flux commerciaux assistés sans action autonome.
Existing overlap: Sales Studio V1 (recherche, score déterministe, brouillon « DRAFT — NOT SENT »), Investment Studio, Sherlock `[REPO]`.
Proposed architecture: §16.
Decision: **CONNECT_EXISTING** (Sales V1) + **BUILD_NATIVE** pour l'approbation commune et un connecteur d'envoi explicite — après Root Policy.
Recommended phase: **P8**

### 8.J MEDIA STUDIO
Problem solved: unifier Recorder / Download / Transcription / Auto Edit / Conversion / Images / Vidéo.
Existing overlap: transcription (`whisper*.js`), rendu (OpenMontage), images (`image-router.js`), téléchargement (yt-dlp) `[REPO]`.
Proposed architecture: §14 (pas de monolithe ; `MediaProvider` + `MediaPipeline`).
Decision: **CONNECT_EXISTING** pour l'existant ; **BUILD_NATIVE** pour Recorder ; **CONNECT** sidecar pour Auto-Editor.
Recommended phase: **P7**

### 8.K INVESTIGATOR (Investigation / evidence graph)
Problem solved: relier des preuves et entités avec relecture humaine.
Existing overlap: Notebook (citations, conflits), Sales provenance, Sherlock (`untrusted`) `[REPO]`.
Proposed architecture: §15.
Decision: **AUDIT_FURTHER** (besoin non établi) → BUILD_NATIVE si un cas d'usage est posé.
Recommended phase: **P9**

### 8.L REVERSE IMAGE PROVIDER
Problem solved: retrouver l'origine d'une image.
Existing overlap: aucun.
Proposed architecture: `ReverseImageProvider` ; implémentation locale (hash perceptuel) + providers cloud derrière UPLOAD = OFF.
Trust boundary: l'image quitte la machine seulement si le provider cloud est activé **pour cette requête**.
Required permissions: UPLOAD OFF par défaut.
Local/cloud behavior: local par défaut.
Security risks: fuite d'images ; faux positifs de hash.
Privacy: images privées interdites de provider cloud (`privacy-guard`).
Failure behavior: provider indisponible ⇒ « aucun résultat », jamais de repli silencieux vers le cloud.
Tests required: spy réseau (0 appel en local), seuils de hash, collisions.
Dependencies: Investigator.
Decision: **DEFER**
Recommended phase: P9+

### 8.M BRAND PRESENCE
Problem solved: disponibilité domaine/pseudo.
Existing overlap: Sherlock (pseudos, pinned) `[REPO]`.
Proposed architecture: RDAP (bootstrap IANA, `availabilityCheck`) pour domaines ; Sherlock pour pseudos ; **pas** d'énumération massive ; cache.
Trust boundary / permissions: EXTERNAL API = OFF par défaut ; requêtes explicites.
Local/cloud behavior: sortant limité (serveurs RDAP publics).
Security risks: faible ; respect des limites de débit.
Privacy: la marque recherchée est révélée aux serveurs RDAP.
Failure behavior: `UNKNOWN` ≠ « disponible ».
Tests required: réponses RDAP 200/404/429 simulées.
Dependencies: Web Egress Guard.
Decision: **DEFER**
Recommended phase: P10

### 8.N PRIVACY DIAGNOSTIC
Problem solved: expliquer cookies/empreinte/traqueurs.
Existing overlap: Journal de confidentialité, Strict Local, détecteurs `cyber-detect-*` `[REPO]`.
Proposed architecture: panneau local, aucune collecte d'empreinte brute, aucun domaine de test.
Decision: **DEFER**
Recommended phase: P10 (si demandé)

### 8.O GAME PRICE WATCH
Problem solved: surveiller des prix (ITAD).
Existing overlap: aucun ; valeur faible.
Proposed architecture: §7.21 ; module isolé, clé DPAPI, pull manuel.
Decision: **DEFER**
Recommended phase: P10

### 8.P PANTRY / RECIPE ASSISTANT
Problem solved: idées de recettes.
Existing overlap: Notebook + LLM local + bibliothèque de prompts.
Decision: **REJECT** (scope creep ; au plus un modèle de prompt)
Recommended phase: —

### 8.Q SUPPORT HELPER
Problem solved: procédures de contact support personnelles.
Existing overlap: Todo/Notebook.
Decision: **DEFER** (modèle de notes ; **aucune téléphonie automatisée**)
Recommended phase: P10

### 8.R DOCTEUR ARCADE
Voir §18.
Decision: **DEFER**
Recommended phase: P11

### 8.S GEO / EVENT LAYERS (OSIRIS / God's Eye View → connecteurs de données)
Problem solved: contexte d'événements publics (séismes, météo spatiale, CVE).
Existing overlap: Observateur ≠ ce domaine ; Kiwix pour la connaissance hors-ligne.
Proposed architecture: connecteurs pull-only derrière Web Egress Guard ; étiquettes `OBSERVED/MODELED/SIMULATED` ; licences affichées.
Decision: **AUDIT_FURTHER** (valeur non démontrée)
Recommended phase: P10+

---

## 9. Browser extension architecture (Media Bridge)

### 9.1 Code de l'extension de l'utilisateur
**UNKNOWN — non fourni.** Rien n'a été inventé sur son fonctionnement. Recherche : aucune extension dans `C:\dev\Docteur` (hors `node_modules`/`external`) ; au premier niveau de `C:\dev`, le seul `manifest.json` est un manifeste PWA sans rapport (`PlaceToBe`). À fournir : dossier de l'extension (manifest + scripts) pour un audit réel (permissions, content scripts, hôtes, mises à jour).

### 9.2 Architecture cible évaluée

```
Chrome Extension (MV3)
   service worker  ── valide sender.origin / schéma ──┐
        │ runtime.connectNative("fr.docteur.media_bridge")
        ▼
Native Messaging (stdio, JSON UTF-8, préfixe 32 bits)
        ▼
Docteur Media Bridge (hôte natif minimal)
   ├─ URL validation (Web Egress Guard)
   ├─ file d'attente bornée + annulation
   ├─ download engine (yt-dlp épinglé, args typés)
   ├─ HLS/ffmpeg (épinglé)
   ├─ progression (messages bornés)
   ├─ dossier de sortie fixe
   └─ historique local optionnel (SQLite Docteur)
```

### 9.3 Faits Native Messaging `[WEB-P]` (doc officielle Chrome)

* Manifeste d'hôte : `name` (minuscules, chiffres, `_`, `.`), `path`, `type: "stdio"`, **`allowed_origins`** (« ne peut pas contenir de jokers »). Sous Windows `path` peut être relatif au manifeste (absolu requis sur Linux/macOS).
* **Windows : une clé de registre est requise** (`HKCU\Software\Google\Chrome\NativeMessagingHosts\<nom>` ou HKLM) pointant vers le manifeste. → *Cette écriture registre est un acte d'installation à faire par l'utilisateur dans une future mission ; rien n'a été modifié ici.*
* Limites : hôte→extension **1 Mo** ; extension→hôte **64 MiB**.
* `connectNative()` : processus persistant jusqu'à fermeture du port ; `sendNativeMessage()` : un processus par message. Indisponible dans les content scripts : passer par le service worker, qui doit **valider `sender.origin`/`sender.url` et assainir la charge** (les content scripts partagent le processus de rendu avec des pages non fiables).

### 9.4 Contrôles retenus

| Sujet | Décision |
|---|---|
| Manifest V3, permissions minimales | `nativeMessaging` + `activeTab` (et éventuellement `contextMenus`) ; **pas de `host_permissions` larges, pas de `<all_urls>`, pas de `cookies`, pas de `webRequest`** |
| Content scripts | aucun, ou le strict minimum pour lire l'URL/titre de la page active à l'action de l'utilisateur |
| Épinglage d'ID | clé `key` dans le manifeste (ID stable) + `allowed_origins: ["chrome-extension://<ID>/"]` exact |
| Schéma de message | liste fermée d'`action` (`enqueue`, `cancel`, `status`), champs typés, `additionalProperties:false`, version de protocole ; rejet de tout le reste |
| Validation d'URL | Web Egress Guard + **allowlist de domaines média** par module (YouTube/Twitch/…) ; schéma https ; jamais d'URL commençant par `-` ; passage à yt-dlp **après `--`** |
| Taille/timeouts/taux | message ≤ 64 Kio ; file ≤ N ; 1 job actif par défaut ; timeout par job ; limiteur de débit par extension |
| Cookies/jetons | **jamais transmis** ; `--cookies-from-browser` interdit |
| Dossier de sortie | fixe, résolu côté hôte (pas de chemin fourni par l'extension) ; noms assainis ; contrôle d'espace disque (`disk-space.js`) |
| Journaux | hôte + durée + code ; **pas d'URL complète** ; pas de contenu |
| Mises à jour | extension distribuée hors store ou store : **pas d'auto-update silencieux** vers un code non audité (version épinglée) ; hôte mis à jour par l'utilisateur |
| Serveur localhost | **aucun listener générique** : Native Messaging suffit ; si l'hôte doit parler à Cortex, préférer un canal local authentifié (named pipe / base partagée) plutôt qu'un port |
| Désinstallation | script de retrait de la clé de registre documenté |

### 9.5 YouTube / Twitch / Discord — accès légitime uniquement

* **YouTube** : URL publique (ou accessible sans contournement) ; métadonnées, qualités, audio/vidéo, sous-titres disponibles ; action manuelle. Existe déjà dans Docteur (yt-dlp).
* **Twitch** : VOD **publiques** et clips. Le contenu réservé à un compte (abonné) n'est **pas pris en charge en V1** : le servir sans extraire de cookies exige un flux d'authentification que Docteur n'a pas → **DEFER** (question de conception ouverte, non résolue ici).
* **Discord** : pièces jointes et liens média **visibles par l'utilisateur**, téléchargement initié depuis le navigateur (l'extension transmet l'URL de la pièce jointe). Les liens CDN sont signés/expirants `[KNOW]` (à vérifier au moment de l'implémentation) → télécharger immédiatement ou échouer proprement. Allowlist : `cdn.discordapp.com`, `media.discordapp.net`.
* **INTERDIT** (règle racine n°3) : self-bot, automatisation par jeton utilisateur, vol/extraction de jetons ou de cookies, contournement d'authentification/abonnement/paywall, DRM.
* **Risque contractuel/juridique (non-avis)** : les conditions de plusieurs plateformes restreignent le téléchargement hors fonctions officielles ; Docteur intègre déjà yt-dlp (résumé vidéo, découverte YouTube) → risque déjà accepté par l'utilisateur ; le pont **ajoute une surface de déclenchement**, pas une nouvelle capacité. Rappeler : usage personnel, aucune redistribution, aucun DRM.

### 9.6 Faisabilité
* Browser Media Bridge : **FEASIBLE** (technique) — **BLOCKED sur UNKNOWN** tant que le code de l'extension n'est pas fourni.
* Discord : **FEASIBLE** via l'extension (URL de pièce jointe), **pas** via l'API avec jeton utilisateur.
* YouTube : **FEASIBLE** (déjà présent).
* Twitch (accès légitime) : **FEASIBLE_PARTIAL** (public) ; contenus de compte = **NOT_SUPPORTED en V1**.

---

## 10. AI history / memory architecture

### 10.1 Ce qui existe déjà `[REPO]`

| Étape du pipeline demandé | État dans Docteur |
|---|---|
| Importer (ZIP/JSON) | **Oui** — `notebook-ai-zip.js` (lecture ZIP durcie, aucune extraction sur disque, `checkEntryName`) |
| Normalisation de schéma | **Oui** — `notebook-ai-adapters.js` (CHATGPT_EXPORT : tableau + `mapping` + `current_node` ; CLAUDE_EXPORT : `chat_messages`/`sender` ; GEMINI_EXPORT : Takeout `MyActivity.json`) — **SYNTHETIC_ONLY** |
| Détection de secrets | **Oui** — par message, BLOCK / REDACT / CONFIRM (`secret-scan.js`) |
| Revue **PII** | **NON** — seulement des secrets ; aucune détection d'e-mails/téléphones/IBAN dans `notebook-ai-schema/security` (grep) → **GAP réel** |
| Déduplication | **Oui** (ids + dédup + supersede, imports incrémentaux) |
| Segmentation | **Oui** (homogène par rôle, sensible aux blocs de code) |
| Séparation des rôles | **Oui** — USER / ASSISTANT / SYSTEM / TOOL / UNKNOWN ; `trustForRole` : `USER_AUTHORED`, `PAST_AI_OUTPUT`, `TOOL_RESULT`, jamais `PRIMARY_SOURCE` |
| Distillation | **Oui** — candidats de mémoire (NB-5), revue humaine, `promotion = NOTEBOOK_ONLY` |
| Chunks + FTS/embeddings | **Oui** (NB-3 : FTS + LanceDB ; défaut chat = FTS) |
| RAG + citations | **Oui** — citations vérifiées, `PAST_AI_ASSERTION`/`UNVERIFIED_PAST_AI` |
| Validité temporelle | **Oui** — révoquée/expirée/future/remplacée exclues (FTS **et** vecteur) |
| Suppression / ré-indexation | **Oui** (rétention, purge, annulation/races) |
| Chiffrement local | **NON** — « currently unencrypted at rest » ; BitLocker évalué, pas recommandé spécifiquement |
| Export de la mémoire | UNKNOWN |
| Pièces jointes | NB-4 §5 « Attachments » existe ; contenu non relu en détail → UNKNOWN |

### 10.2 Menaces couvertes (preuves NB-4/NB-6/NB-7)

Texte historique « run PowerShell / call OMEGA / send email / exfiltrate » stocké comme **donnée** (balises de rôle, drapeaux `HISTORICAL_SYSTEM_MESSAGE`/`TOOL_OUTPUT`/injection), 0 `child_process`, 0 fetch, contrat de réponse **sans canal d'action**, `authority: CONTEXT_ONLY`, déclarations encadrées par une borne aléatoire par requête, mémoire empoisonnée avec lignes vectorielles désynchronisées (la ligne SQL fait foi), injection FTS (`" OR "1"="1`) sans effet, fuite inter-projet/inter-notebook 0, aucune mémoire dans les autres chats.

### 10.3 Écarts / à auditer

1. **Aucun export réel validé** (ChatGPT/Claude/Gemini = SYNTHETIC_ONLY ; `nb7-validate-real-export.mjs` prêt, sortie anonymisée). → Mission courte : l'utilisateur fournit un export, le validateur tourne (preview, pas d'import).
2. **PII** (gap) : proposer un scanner PII *affichant* (jamais envoyant) avec confirmation, comme pour les secrets.
3. **Chiffrement au repos** : décision utilisateur (BitLocker du disque vs chiffrement applicatif) ; ne pas bricoler un schéma maison.
4. **Gemini** : Takeout « Activity » est un journal d'activité plutôt que des fils de conversation (limite notée par NB-4) → fidélité partielle attendue.
5. **Réponses contradictoires / hallucinations anciennes** : déjà traitées par les marqueurs `UNVERIFIED_PAST_AI` ; vérifier avec un corpus réel.

### 10.4 Faisabilité (réponses à la fiche finale)

| Export | Faisabilité | Preuve |
|---|---|---|
| ChatGPT | **FEASIBLE — adapter existe, SYNTHETIC_ONLY** | `notebook-ai-adapters.js` ; format `conversations.json` + arbre `mapping` confirmé par des sources tierces `[WEB-S]` |
| Claude | **FEASIBLE — adapter existe, SYNTHETIC_ONLY** | `conversations.json` (`chat_messages`, `sender`) `[WEB-S]` ; export natif par e-mail (lien 24 h) |
| Gemini | **FEASIBLE_PARTIAL** | Google Takeout (JSON ou HTML) `[WEB-S]` ; structure d'activité |

Principe maintenu : **MODEL INTELLIGENCE ≠ CONTEXTUAL INTELLIGENCE** — aucun entraînement du modèle ; le gain est un contexte cité, révisable, révocable.

---

## 11. QR transfer architecture

### 11.1 Flux
```
Docteur UI "Envoyer/Recevoir"  (action utilisateur, TRANSFER)
   → crée une session : id (128 bits), jeton à usage unique (≥128 bits), TTL court, direction, fichier(s)
   → ouvre UN listener éphémère lié à UNE interface LAN privée choisie (jamais 0.0.0.0, jamais IP publique)
   → QR = https://<ip-lan>:<port-aléatoire>/t/<sessionId>#<jeton>
   → téléphone/PC scanne → page minimale servie par le listener
   → transfert (flux, plages, hash) → vérification SHA-256 des deux côtés
   → session détruite (succès, annulation, expiration, erreur) ; listener fermé
```

### 11.2 Choix techniques et pourquoi

| Option | Verdict |
|---|---|
| **HTTPS local éphémère** (natif) | **Retenu**. Simple, LAN, pas de signalisation ni ICE. Docteur exige déjà TLS pour le LAN (`server.js`). |
| qrcp (HTTP clair, pas d'auth) | Idées seulement (§7.24) |
| FilePizza / WebRTC | LAN : surcoût ; Internet : hors Strict Local (§7.23) |
| WebSocket | inutile pour un fichier ; possible pour la progression |
| « direct socket » | non (navigateur) |

### 11.3 Point délicat — TLS sur un téléphone
Un certificat auto-signé déclenche un **avertissement navigateur** ; WebCrypto (`crypto.subtle`) exige un **contexte sécurisé** donc HTTPS (sinon pas de chiffrement applicatif en JS). Options : (a) certificat local déjà utilisé par le mode mobile (`certs/`, `scripts/gen-cert.mjs`) — **comment le téléphone le fait-il confiance aujourd'hui ? UNKNOWN** ; (b) avertissement accepté une fois par session et documenté ; (c) **ne pas** inclure un secret dans l'URL envoyée au serveur : le jeton est dans le **fragment** (`#`, jamais transmis dans la requête HTTP) puis envoyé par la page en `POST`. À trancher en mission de conception.

### 11.4 Jeton et session
128 bits d'entropie (CSPRNG), **comparaison à temps constant**, usage unique (consommé au premier `POST`/`GET` valide), TTL ≤ 5 min avant premier usage, ré-émission = nouvelle session, limite d'essais, rejet de rejeu, journal sans le jeton. Le jeton est lié à l'**IP du pair** après le premier usage (optionnel).

### 11.5 Réseau
Binding **explicite** à l'IPv4 d'une interface sélectionnée dans l'UI ; refus si l'adresse n'est pas privée (RFC1918/ULA/CGNAT selon politique) ; pas de découverte LAN automatique (pas de mDNS) ; aucun listener permanent (« aucun listener permanent par défaut ») ; **pare-feu : Windows demandera l'autorisation d'entrée au premier `listen` de `node.exe`** — Docteur **ne modifie pas** le pare-feu (interdit) et l'explique à l'utilisateur.

### 11.6 Fichiers
Découpage en plages (HTTP `Range`) pour **reprise** ; hash par fichier (SHA-256) vérifié des deux côtés ; fichier `.part` renommé seulement après vérification ; espace disque vérifié avant (`disk-space.js`) ; nom assaini (modèle `safeRelative` de `external-agent-policy.js` : séparateurs, `..`, noms réservés Windows `CON/PRN/AUX/NUL/COMn/LPTn`, espaces/points finaux) ; **aucune extraction d'archive** ; pas de liens symboliques (`lstat`) ; `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` ; taille max configurable ; annulation propre (suppression des `.part`).

### 11.7 Séparation des domaines de confiance
`TRANSFER ≠ OMEGA ≠ RASSILON ≠ Device Fabric` : clé/certificat **dédiés** ; zéro import de ces modules (le test statique DF #23 échouerait) ; Device Fabric peut **afficher** l'appareil mais le transfert n'octroie **aucune** capacité OMEGA/RASSILON.

### 11.8 Tests requis
Jeton rejoué/expiré/mauvais ; énumération d'ID ; binding sur interface non privée refusé ; second pair refusé ; fichier tronqué/hash faux ; disque plein ; noms hostiles (`..\`, `CON`, Unicode RTL) ; gros fichier (≥ 4 Gio) en flux ; reprise après coupure ; annulation ; fermeture du listener (test de port) ; scanner de ports local ; **test physique** téléphone ↔ PC (non automatisable : multi-appareils).

### 11.9 Faisabilité
QR File Transfer : **FEASIBLE**. Gros fichiers : **FEASIBLE** (flux + `Range`, tests ≥ 4 Gio requis). Reprise : **FEASIBLE**. Chiffrement : **FEASIBLE via TLS** (E2E applicatif = optionnel). Jeton QR à usage unique : **FEASIBLE**.

---

## 12. Root Policy architecture

### 12.1 Pourquoi pas seulement un prompt
Un prompt système n'est pas un contrôle : il est contournable par injection. La règle doit être **vérifiée par code au point d'exécution** : un exécuteur refuse d'agir sans jeton d'autorisation délivré par le moteur.

### 12.2 Composants
```
Demandeur (UI | IA locale | IA cloud | agent | plugin | extension | MCP)
        │  action sémantique + paramètres typés (jamais une commande)
        ▼
 ROOT POLICY ENGINE (décision pure : acteur × capacité × cible × contexte)
   ├─ DENY  → événement d'audit, code stable
   ├─ APPROVAL_REQUIRED → file d'approbation locale (UI, lien au hash de l'action, usage unique, TTL)
   └─ ALLOW → jeton d'autorisation signé (HMAC) lié à l'action
        ▼
 EXÉCUTEUR RÉEL — vérifie le jeton ; sinon refuse (fail closed)
```
Registre fermé d'**actions sémantiques** (`RESTART_SERVICE:cortex`, `DOWNLOAD_MEDIA`, `TRANSFER_SEND`, …), chacune avec : capacité requise, niveau d'impact, approbation, modules autorisés.

### 12.3 Règles racines (audit de faisabilité)
| # | Règle | Faisable en code ? | Remarque |
|---|---|---|---|
| 1 | Strict Local par défaut | **Oui** (déjà : `strict-local.js`) — à rendre **obligatoire par capacité** (`network:external`) | |
| 2 | Aucun secret vers un modèle/provider sans autorisation | **Oui** — étendre `privacy-guard` en pré-condition de tout appel sortant | |
| 3 | Aucun contournement d'auth/paiement/contrôle d'accès | **Partiel** — non vérifiable de façon générale ; réalisable comme **allowlist d'actions** (pas de `cookies`, pas de `--cookies-from-browser`, pas de solveurs anti-bot) et revue de PR | |
| 4 | Fort impact ⇒ approbation humaine locale | **Oui** — primitive commune (hash d'action, usage unique) | |
| 5 | Pas de shell arbitraire pour une IA | **Oui** — aucune action `exec(string)` au registre ; test statique | |
| 6 | Domaines de confiance séparés | **Oui** — déjà démontré pour DF | |
| 7 | STOP/révocation prioritaire | **Oui** — drapeau global lu avant chaque `enforce()` | |
| 8 | Aucune IA/plugin/outil ne modifie la Root Policy | **Oui** (voir §12.4) | |
| 9 | UNKNOWN ⇒ échec fermé | **Oui** | |

### 12.4 Protection locale du fichier de politique (honnête sur les limites)
* **Lecture seule ≠ protection** (un processus du même compte peut changer l'attribut).
* Défense en couches : (1) **signature** : le fichier de politique est signé hors-application (clé privée **jamais** dans Docteur ; clé publique embarquée/épinglée) ; au démarrage, signature invalide ⇒ **mode sûr** (opérations protégées refusées) ; (2) **hash** + numéro de **version** monotone (anti-rollback) ; (3) **ACL Windows** : dossier appartenant à un autre propriétaire/administrateur, droit d'écriture refusé au compte qui exécute Docteur (mise en place **une fois** par l'humain, élévation requise) ; (4) **copie de secours** vérifiée ; (5) **journal d'audit** chaîné (hash précédent) ; (6) **procédure de remplacement** : un outil CLI **séparé**, non importable ni appelable par l'API de Docteur, exige une action locale explicite.
* **Limite reconnue** : un administrateur/propriétaire complet de la machine peut modifier le logiciel ou son stockage. Objectif = **non modifiable par les IA, plugins, exécuteurs de Docteur ; altération détectable ; remplacement par procédure humaine locale**. Pas d'« immutabilité magique ».
* Les agents qui écrivent du code (MetaGPT, external-agents) travaillent dans des **workspaces isolés** `[REPO]` : ils ne peuvent déjà pas écrire dans `src/` ; le dossier de la politique doit être **hors** de tout workspace et exclu de `BLOCKED` comme `data|certs|…`.

### 12.5 Migration et couverture (franchise)
* Montage progressif : **nouveaux** exécuteurs d'abord (Supervisor, Transfer, Media Bridge, Document Toolbox) → ils **ne démarrent pas sans** moteur.
* **Modules gelés** (DF, OMEGA, RASSILON, MAÎTRE, Observateur) : ne sont pas modifiés ; leurs contrôles certifiés restent ; un **test de conformité statique** peut seulement *lister* ceux qui n'appellent pas la Root Policy (gap documenté, jamais prétendu couvert). L'intégration dans les modules gelés = missions d'unfreeze séparées.
* Version de politique + migration + restauration : chaque schéma versionné.

### 12.6 Faisabilité
Root Policy : **FEASIBLE** ; application par code : **OUI** (pour tout exécuteur qui l'adopte) ; modification par IA autorisée : **NON** ; détection d'altération : **OUI** (signature + hash + audit) ; échec fermé : **OUI**.

---

## 13. Runtime Supervisor architecture

### 13.1 Problème structurel
**Cortex ne peut pas se relancer lui-même.** Le superviseur doit être un **processus parent minimal et séparé** (le rôle que jouent aujourd'hui les `.bat`). Cortex expose l'état, l'UI envoie une *intention* (`RESTART:cortex`), le parent exécute.

### 13.2 Liste fermée de composants
| ID | Exécutable attendu | Arguments autorisés | cwd | Health check | Dépendances |
|---|---|---|---|---|---|
| `cortex` | `node.exe` (chemin absolu épinglé) | `src/server.js` (+ drapeaux d'une liste) | `cortex-server/` | endpoint de santé existant (`routes/health.js`, loopback ; chemin exact à confirmer) | `ollama` (soft) |
| `frontend` | `node.exe` + vite | script fixé | racine | port 5173 | `cortex` |
| `ollama` | `ollama.exe` | `serve` | — | `GET 127.0.0.1:11434` | — |
| `worker` (RASSILON) | module existant | — | — | statut de son propre service | `cortex` |

Pour chacun : ID constant, exécutable, args autorisés, cwd, health, PID, uptime, statut, **politique de redémarrage**, compteur de plantages, dernier code de sortie, dernière erreur, chaîne de dépendances. États : `STARTING, HEALTHY, DEGRADED, CRASHED, STOPPED, RESTARTING, UNKNOWN`.

### 13.3 Interdits (testés statiquement)
Aucun champ « commande » ; aucun `cmd`/`powershell` libre ; aucun chemin d'exécutable ni argument fourni par un LLM ou l'UI ; `shell:false` ; l'UI n'envoie que `{componentId, action ∈ {START, STOP, RESTART}}`.

### 13.4 Robustesse
Backoff exponentiel plafonné ; **max N relances / fenêtre** puis `CRASHED` verrouillé (déblocage humain) ; redémarrage des dépendants dans l'ordre ; propriété de processus par **PID + temps de création** (anti-réutilisation de PID) — le modèle `process-tree.js` existe (PID issu de l'objet `ChildProcess` spawné par Docteur) ; arrêt **gracieux** puis forcé en dernier recours (`taskkill /T /F` seulement sur un PID possédé) ; nettoyage des zombies ; logs bornés ; **Job Object** Windows pour l'arbre (nécessite un lanceur natif ou un helper : hors Node pur) ; `UNKNOWN` quand l'état ne peut être prouvé (jamais « HEALTHY » par défaut).

### 13.5 Root Policy
Chaque action passe par `enforce(RESTART_SERVICE, componentId)` ; STOP global prioritaire ; élévation (UAC) **jamais** demandée.

### 13.6 Faisabilité
Supervisor : **FEASIBLE** ; **shell arbitraire requis : NON** ; liste sémantique fermée : **FEASIBLE**. Dépend de la décision « parent séparé » (nouveau binaire/script signé).

---

## 14. Media architecture

```
MEDIA
 ├─ Recorder (RECREATE_NATIVE)         navigateur getDisplayMedia/MediaRecorder ; ffmpeg optionnel
 ├─ Download Bridge (§9)               Native Messaging → yt-dlp épinglé
 ├─ Transcription                      EXISTANT (whisper local/Groq, Strict Local aware)
 ├─ Auto Edit (CONNECT_AS_SIDECAR)     auto-editor épinglé, args typés
 ├─ Conversion                         ffmpeg épinglé (liste fermée de préréglages)
 ├─ Image Generation                   EXISTANT (image-router : local/gratuit-cloud)
 ├─ Video Generation                   EXISTANT (OpenMontage/Remotion local)
 └─ Export                             dossier de sortie dédié
```
* **Abstractions** : `MediaProvider { capabilities(), submit(job), poll(id), cancel(id) }` (généralise `image-router`), `MediaPipeline` = suite d'étapes typées (entrée → étape → sortie) avec journal de provenance (outil, version, SHA du binaire, paramètres). **Pas de monolithe** : chaque étape = un exécuteur sous Root Policy.
* **Coopération** : `Recorder → Auto-Editor → (OpenMontage | ffmpeg) → Export` ; `Bridge → Transcription → Notebook` ; `Image provider cloud → désactivé par défaut`.
* **Open-Higgsfield** : ne s'intègre pas ; ses idées (soumission/poll, coût estimé) alimentent `MediaProvider`.
* **Faisabilité Media Studio** : **FEASIBLE** par petites étapes (CONNECT_EXISTING + 2 nouveaux maillons) ; **monolithe à éviter**.

---

## 15. Investigation architecture (Docteur Investigator)

```
RESEARCH → EVIDENCE → ENTITY RESOLUTION → GRAPH → HUMAN REVIEW
```
* **RESEARCH** : documents Notebook + pages via Web Research Adapter (DATA non fiable) ; **aucun shell**, aucune écriture hors dossier de session.
* **EVIDENCE** : chaque affirmation = extrait + source + horodatage + hash ; les contenus web portent `UNTRUSTED_WEB`.
* **ENTITY RESOLUTION** : règles déterministes d'abord (normalisation, identifiants), LLM local seulement pour **proposer** des fusions (`PROPOSED`), jamais pour les appliquer.
* **GRAPH** : tables SQLite (nœuds/arêtes/preuves) ; arêtes `PROPOSED → CONFIRMED` uniquement par l'humain ; Cytoscape côté UI (idée d'OpenPlanter).
* **HUMAN REVIEW** : file de validation (comme `reviewCandidate` du Notebook).
* Étiquette obligatoire des données : `OBSERVED / MODELED / SIMULATED / CLAIMED`.
* **Interdits** : recherche de personnes privées, reconnaissance faciale, profilage d'individus, caméras/ALPR (limite que God's Eye View affiche lui-même).
* Observateur reste **hors** de ce module.
* **Faisabilité** : FEASIBLE ; **valeur à démontrer** (cas d'usage non posé) → AUDIT_FURTHER.

---

## 16. Agency architecture

```
RESEARCH → ANALYZE → SCORE → DRAFT → HUMAN REVIEW → EXPLICIT ACTION
```
* État réel `[REPO]` : Sales Studio V1 couvre `RESEARCH→SCORE→DRAFT` avec `DRAFT — NOT SENT` ; **l'étape EXPLICIT ACTION n'existe pas** (0 SMTP, 0 CRM, 0 calendrier — confirmé par `AGENCY_AGENTS_AUDIT`).
* **Pas dans la V1 d'Agency** : auto-buy, auto-send, auto-publish, auto-contact, modification autonome de CRM.
* Primitive requise (gap) : **approbation commune** (hash de l'action + destinataire + contenu, usage unique, TTL) fournie par la Root Policy.
* Chatwoot (boîte support) : DEFER ; Postiz (publication) : DEFER — dans les deux cas, Docteur n'a **jamais** de jeton de publication/envoi dans la base métier ; si un jour connecté, jetons dans un coffre dédié par module (DPAPI) et **action d'envoi isolée**.
* **Faisabilité Agency** : FEASIBLE pour DRAFT/REVIEW (existant) ; **EXPLICIT SEND = P8, après Root Policy**.

---

## 17. Code Intelligence architecture

* **Existant** `[REPO]` : `code-intel-workspace.js` (racine de workspace + `.gitignore`), `code-intel-search.js` (ripgrep `@vscode/ripgrep`, `spawn`/`execFile` `shell:false`, timeout 8 s, sortie ≤ 4 Mo, ≤ 200 résultats, requête ≤ 512 caractères, extraits ≤ 300 ; **symboles par regex** : `function`, `class`, `const`…), `code-intel-git.js` (`status/diff/log/show`, `shell:false`). 78/78 tests selon son checkpoint.
* **Manques réels** : références/définitions précises (regex ≠ analyse), `blame`, arbre du dépôt structuré, index local persistant.
* Options : **tree-sitter** (grammaires WASM, MIT) pour symboles/références syntaxiques sans exécuter de code ; **LSP** (exécute un serveur de langage = processus tiers, ex. `typescript-language-server` → surface supplémentaire, DEFER) ; **libgit2** (binding natif, dépendance de build) vs **Git CLI allowlisté** (déjà fait, simple) → conserver le CLI allowlisté et **ajouter `blame`** seulement ; index local = SQLite/FTS sur symboles tree-sitter.
* Opérations Git **mutantes interdites** (déjà vrai).
* **Faisabilité** : **CONNECT_EXISTING** ; amélioration tree-sitter = AUDIT_FURTHER, priorité basse.

---

## 18. Game preservation / clean-room analysis

> Analyse technique et de risque, **pas un avis juridique**.

### 18.1 MINION RUSH (Gameloft / licence Illumination-Universal)
* Faits `[WEB-S]` : le client **Windows est défunct** (serveurs arrêtés, TCRF) ; la version mobile reçoit encore des mises à jour en 2026 et se joue « hors ligne ».
* **A. Préservation personnelle** : l'objet légitime est la **sauvegarde de ses propres fichiers/données** par les outils officiels de l'OS/du compte. Docteur n'a aucune raison d'ajouter une fonction qui extrait/rejoue des binaires de jeu : ce serait au mieux de la préservation d'un logiciel soumis à licence et à comptes de boutique, au pire du contournement (DRM, serveurs) — **exclu**. Conclusion : **aucune fonction Docteur** ; recommander les sauvegardes officielles de l'appareil.
* **B. Recréation clean-room** : le **genre** (runner infini) et des mécaniques génériques (esquive, collecte, progression) sont des idées ; **personnages, Minions, noms, logos, musiques, niveaux, textes, interfaces identiques = interdits**. Possible : jeu **original** (univers, personnages, assets, niveaux, code originaux).

### 18.2 CUT THE ROPE (ZeptoLab)
* Faits `[WEB-S]` : versions HTML5 **officielles** par Famobi sous licence ZeptoLab, jouables gratuitement ; **Cut the Rope Remastered fermé début 2024** ; une extension Chrome permet de jouer à l'original hors ligne.
* **A. Préservation** : voies officielles existantes ; **aucune fonction Docteur** (pas d'extraction, pas de contournement).
* **B. Clean-room** : mécanique « physique de corde/pendule + collecte » = idée ; interdits : Om Nom, noms, niveaux, assets, interface identique. Bibliothèques de physique 2D permissives disponibles `[KNOW]` (Box2D/Planck.js/Matter.js : à vérifier).

### 18.3 Docteur Arcade (si un jour)
* Module **isolé** : iframe `sandbox` **sans** `allow-same-origin`, origine séparée, CSP `connect-src 'none'`, aucun accès aux API Docteur (le garde NB-7 refuse déjà les origines étrangères), stockage limité au score.
* **Aucun** accès OMEGA/RASSILON/secrets/Notebook/Root Policy ; aucune permission réseau implicite.
* Valeur pour la mission de Docteur : **faible** ; risque de scope creep. **DEFER (P11)**.
* Statut demandé : *Minion Rush preservation* = **NOT_APPLICABLE / hors périmètre** ; *clean-room* = **FEASIBLE mais DEFER** ; *Cut the Rope preservation* = **NOT_APPLICABLE** (voies officielles) ; *clean-room* = **FEASIBLE mais DEFER**.

---

## 19. Synergy map

Chaque synergie du prompt est confrontée à l'état réel. ✔ = valide ; ✎ = à remodeler ; ✘ = à abandonner.

| Synergie demandée | Verdict | Forme recommandée |
|---|---|---|
| CAP → AUTO-EDITOR → MEDIA PIPELINE → OPEN-HIGGSFIELD | ✎ | `Recorder natif → Auto-Editor (sidecar) → OpenMontage/ffmpeg → Export`. Cap et Open-Higgsfield ne sont **pas** dans la chaîne (idées seulement). |
| OSIRIS → OBSERVATEUR → OPENPLANTER/INVESTIGATOR → NOTEBOOK | ✘ au maillon Observateur (hôte local, §1.2) | `Connecteurs de données publics (sélection) → Investigator → Notebook`, Observateur **inchangé**. |
| OBSERVATEUR → GOD'S EYE VIEW SOURCES → EVIDENCE GRAPH | ✘ | idem ; couches étiquetées `OBSERVED/MODELED/SIMULATED`. |
| TINEYE → OBSERVATEUR → INVESTIGATOR → NOTEBOOK | ✎ | `ReverseImageProvider → Investigator → Notebook` ; local d'abord ; pas d'Observateur. |
| NAMECHK → BRAND PRESENCE → OBSERVATEUR | ✎ | `RDAP + Sherlock → Brand Presence` ; pas d'Observateur. |
| CHATWOOT → AGENCY → HUMAN REVIEW | ✎ (DEFER) | Agency produit des brouillons ; pas de boîte de réception. |
| AGENCY → POSTIZ → EXPLICIT PUBLISH | ✎ (DEFER) | action d'envoi/publication isolée, approuvée, usage unique. |
| BROWSER EXTENSION → NATIVE MESSAGING → MEDIA BRIDGE → DOCTEUR | ✔ (UNKNOWN : extension non fournie) | §9. |
| DISCORD/YOUTUBE/TWITCH → MEDIA BRIDGE → LOCAL PROCESSING | ✔ pour l'accès légitime | Discord = URL de pièce jointe ; Twitch compte = non pris en charge V1. |
| EXPORTS CHATGPT/CLAUDE/GEMINI → MEMORY IMPORT → NOTEBOOK → RAG | ✔ **déjà existant** | validation réelle seulement (§10). |
| FILEPIZZA / QRCP IDEAS → QR TRANSFER → DEVICE FABRIC INVENTORY (optionnel) | ✔ | Device Fabric **affiche** seulement ; **QR trust ≠ OMEGA trust ≠ RASSILON trust**. |
| ROOT POLICY → TOUS LES EXÉCUTEURS | ✔ avec franchise | nouveaux exécuteurs d'abord ; modules gelés listés comme non couverts jusqu'à unfreeze (§12.5). |
| RUNTIME SUPERVISOR → INFRASTRUCTURE → ROOT POLICY | ✔ | `RESTART_SERVICE` = action du registre. |

---

## 20. License matrix

> Pas un avis juridique. Contexte : Docteur est un projet **privé** (`"private": true`), usage local/personnel `[REPO]`. Les obligations changent si Docteur est **distribué** ou exposé comme **service réseau**. Relire chaque `LICENSE` brut au moment du pin.

| Projet | Licence racine | Mixte / données / modèles | Obligation clé | Impact Docteur |
|---|---|---|---|---|
| Open-Higgsfield | MIT | sous-modules UNKNOWN ; **modèles** : licences propres (parfois NC) ; passerelle muapi.ai : ToS UNKNOWN | attribution | faible (idée seulement) |
| Cap | **AGPL-3.0** | `cap-camera*`, `scap-*` **MIT** | AGPL : source de toute œuvre dérivée/liée, y compris offerte en réseau | Recréer ; si crates MIT seulement → attribution |
| Auto-Editor | Unlicense | **binaire** : FFmpeg + x264/x265 (**GPL**) | si redistribution du binaire → GPL ; sinon aucune | sidecar : l'utilisateur télécharge → OK |
| TwitchNoSub | Apache-2.0 | — | — | REJECT (fonction = contournement) |
| OSIRIS | MIT | **par source** (OpenSky, FIRMS, N2YO, caméras, OpenSanctions `[KNOW]` NC, Telegram ToS) | respecter chaque source | idées seulement |
| OpenPlanter | MIT | fournisseurs (Exa, Voyage…) | — | idées seulement |
| God's Eye View | MIT | **datasets séparés** (DATA_SOURCES.md) ; tuiles Google 3D **non commercial** via Cesium ion | non commercial | idées seulement |
| TinEye | propriétaire (API) | conditions d'utilisation UNKNOWN | quota payant en commercial | DEFER |
| Namechk | propriétaire | base non copiable | — | idées seulement |
| Cover Your Tracks | **AGPL-3.0** | — | AGPL | idées seulement |
| Scrapling | BSD-3-Clause | navigateurs/outils d'empreinte : propres licences | attribution | idées seulement |
| Obscura | Apache-2.0 | `jpeg-encoder` IJG (issue #1125) ; dépendances Rust variées | attribution, NOTICE | DEFER |
| Memos | MIT | — | — | idées seulement |
| Chatwoot | MIT | **`enterprise/` licence séparée** | — | DEFER |
| Postiz | **AGPL-3.0** | marque/enterprise UNKNOWN | AGPL | DEFER |
| GetHuman | propriétaire | base non copiable | — | idées seulement |
| Show Me The Money | **CC BY-NC 4.0** (ex-MIT jusqu'à < 2.2.0) | CC non adaptée au logiciel | non commercial ; licence commerciale séparée | **REJECT** |
| PDF24 | freeware propriétaire | Ghostscript (A)GPL en CLI | pas d'usage séparé des composants | idées seulement |
| IsThereAnyDeal | conditions d'API | — | pas d'affiliation suggérée, pas de retrait d'affiliation, pas d'app concurrente ; attribution recommandée | DEFER |
| MyFridgeFood | propriétaire | recettes soumises par les utilisateurs | droit d'auteur | REJECT (module) |
| FilePizza | BSD-3-Clause | — | attribution | idées seulement |
| qrcp | MIT | — | — | idées seulement |
| OpenMontage (déjà intégré) | AGPL-3.0 | — | isolation subprocess (analysée en OM-1 : risque FAIBLE) | existant |

Libs PDF candidates `[KNOW]`, **à relire** : qpdf Apache-2.0 ; pdf-lib MIT ; pdfcpu Apache-2.0 ; PDFium BSD/Apache ; pdf.js Apache-2.0 ; Tesseract Apache-2.0 ; OCRmyPDF MPL-2.0 ; Ghostscript AGPL ; MuPDF AGPL.

---

## 21. Cloud / network / cost matrix

Coûts : `FREE_LOCAL`, `FREE_WITH_LIMITS`, `PAID_API`, `PAID_INFRA`, `UNKNOWN`.

| Projet / fonction | Destinations réseau | Nécessaire ? | Désactivable ? | Hors-ligne | Données transmises | COÛT |
|---|---|---|---|---|---|---|
| Open-Higgsfield | muapi.ai (`/api/v1/*`, upload) | oui (mode principal) | non (sauf moteurs locaux desktop) | local sd.cpp/Wan2GP seulement | prompts, **images** | PAID_API (UNKNOWN tarifs) ; GPU pour local |
| Cap | Cap Cloud, S3, Tinybird | non (Studio local) | oui (UNKNOWN précisément) | Studio local probable | enregistrements si partagés ; télémétrie de visionnage | FREE_LOCAL / PAID_INFRA (auto-hébergé) |
| Auto-Editor | aucun connu | non | — | oui (à tester) | — | FREE_LOCAL |
| Extension + Media Bridge | site source (YouTube/Twitch/Discord CDN) | oui (le téléchargement) | par action | non (source distante) | URL requêtée vers la source | FREE_LOCAL |
| TwitchNoSub | Twitch | — | — | — | — | — (REJECT) |
| OSIRIS | OpenSky, USGS, FIRMS, EONET, SWPC, N2YO, caméras, NVD, blockstream, OpenSanctions, Telegram | oui | par source | vide | requêtes (IP) | FREE_WITH_LIMITS (clés) |
| OpenPlanter | OpenAI, Anthropic, OpenRouter, Cerebras, Exa, Voyage, URL arbitraires | oui sauf Ollama local | par fournisseur | Ollama local possible | prompts, données investiguées | PAID_API / FREE_LOCAL (Ollama) |
| God's Eye View | OpenSky, adsb.lol, AISStream, CelesTrak, USGS, TomTom, caméras, FIRMS, NOAA, Esri/OSM, Google/Cesium, OpenAI Realtime | oui | par couche | non | requêtes ; voix : **audio vers OpenAI** | FREE_WITH_LIMITS ; voix PAID_API (« quelques cents/min », plafond 5 $) |
| TinEye | api.tineye.com | oui | oui | non | **image / URL** | PAID_API (0,01-0,04 $/req) |
| Namechk / RDAP | namechk.com ; serveurs RDAP publics | oui | oui | non | nom recherché | UNKNOWN / FREE_WITH_LIMITS |
| Cover Your Tracks | serveur EFF ou auto-hébergé ; domaines tiers de test | oui | auto-héberger | non | **empreinte du navigateur** | FREE_WITH_LIMITS / PAID_INFRA |
| Scrapling | cibles arbitraires, proxys, téléchargement navigateurs | oui | — | parseur seul : oui | requêtes | FREE_LOCAL (+ proxys payants optionnels) |
| Obscura | cibles arbitraires, proxys | oui | — | moteur local | requêtes | FREE_LOCAL |
| Memos | aucun | non | — | oui | — | FREE_LOCAL / PAID_INFRA |
| Chatwoot | hub.chatwoot.com (désactivable), canaux (SMTP, WhatsApp, Meta…) | oui | télémétrie : `DISABLE_TELEMETRY` | non | contacts, messages | PAID_INFRA |
| Postiz | API de chaque réseau social | oui | par réseau | non | **contenu publié, jetons OAuth** | PAID_INFRA (+ API) |
| GetHuman | gethuman.com | oui | — | non | — | FREE_WITH_LIMITS (publicité) |
| Show Me The Money | npm (`npm view`, upgrade), Google/Meta Ads, Stripe, X, LinkedIn, Reddit, API d'images | oui | partiel | non | données business | PAID_API |
| PDF24 (Creator / web) | web : upload vers PDF24 ; Creator : UNKNOWN | web oui | utiliser Creator/alternatives | Creator oui (UNKNOWN) | **documents (web)** | FREE_WITH_LIMITS |
| IsThereAnyDeal | api.isthereanydeal.com | oui | oui | non | titres de jeux | FREE_WITH_LIMITS (1000/5 min) |
| MyFridgeFood | myfridgefood.com | oui | — | non | — | FREE_WITH_LIMITS |
| FilePizza | **0.peerjs.com**, **stun.l.google.com** par défaut ; TURN option | oui par défaut | auto-héberger PeerJS, retirer STUN | LAN possible (non documenté) | métadonnées ICE/signalisation | FREE_LOCAL (LAN) / PAID_INFRA (TURN) |
| qrcp / QR Transfer natif | **LAN uniquement** | non | — | oui | fichiers (LAN) | FREE_LOCAL |
| Document Toolbox | aucun | non | — | oui | — | FREE_LOCAL |
| Root Policy / Supervisor | aucun | non | — | oui | — | FREE_LOCAL |

---

## 22. Secrets matrix

Règle Docteur : un secret est stocké **uniquement** via `secret-store.js` (DPAPI, `CurrentUser`, entropie dédiée) ; **jamais** dans la base métier en clair, **jamais** en `localStorage`, jamais dans les logs (`redactSecrets`), jamais envoyé à un modèle (`privacy-guard`/`secret-scan`). Un jeton **par module** (pas de secret partagé entre domaines).

| Projet / fonction | Secrets | Stockage dans Docteur (si un jour intégré) |
|---|---|---|
| Open-Higgsfield | clé Muapi (en `localStorage` chez eux) | DPAPI par module Media ; jamais `localStorage` |
| Cap | clés S3/DB, compte Cloud | non applicable (recréation native) |
| Auto-Editor | aucun | — |
| Extension / Bridge | **aucun** (pas de cookies/jetons) ; clé d'identité du pont : paire locale | fichier ACL / DPAPI |
| OSIRIS / God's Eye View | clés FIRMS, OpenSky OAuth, N2YO, AIS, Google/Cesium, TomTom, OpenAI | DPAPI par connecteur ; proxy serveur seulement ; **jamais côté navigateur** ; refuser `--host 0.0.0.0` (le proxy relaye les clés au LAN) |
| OpenPlanter | clés OpenAI/Anthropic/OpenRouter/Cerebras/Exa/Voyage | non applicable (idées) |
| TinEye | clé API | DPAPI ; consentement par requête |
| Postiz / Chatwoot | **jetons OAuth/refresh sociaux**, SMTP, jetons de canaux | **coffre dédié** hors base métier, action d'envoi isolée ; DEFER |
| Show Me The Money | clés Ads/Stripe/sociales | **jamais** dans Docteur |
| IsThereAnyDeal | clé API ; OAuth wishlist | DPAPI |
| QR Transfer | jeton de session éphémère ; clé TLS du transfert | mémoire seulement ; clé TLS dédiée, ACL |
| Root Policy | clé publique (embarquée) ; clé privée de signature **hors Docteur** | clé privée sur support humain |
| Connecteurs existants (YouTube/Drive/OneDrive) | Client ID/Secret, jetons OAuth | `connector-registry.js` + secret-store (existant ; non réaudité ici) |

---

## 23. Threat model

### 23.1 Attaquants A→L

| Att. | Description | Architectures concernées | Surface | Frontière | Mitigation (existante / proposée) | Risque résiduel |
|---|---|---|---|---|---|---|
| **A** | page Web hostile | Web Research, Bridge, API locale | contenu HTML/JS, redirections, SSRF, CSRF/DNS-rebinding vers `127.0.0.1` | navigateur ↔ API ; Docteur ↔ Internet | `local-request-guard` (existant, 459 routes) ; **Web Egress Guard (P0)** ; contenu = DATA | routes **gelées exemptées** ; pas de CSP ; `[::ffff:…]` aujourd'hui non bloqué |
| **B** | repository compromis | tout `git clone` externe | branche nommée comme le SHA, sous-modules | Git ↔ disque | pin 40 hex + `rev-parse HEAD` + refus de branche homonyme | dépendances transitives |
| **C** | paquet npm/pip/cargo compromis | Toutes dépendances | postinstall, typosquat | registre ↔ build | lockfile, `--ignore-scripts`, wheels + hash, SBOM | npm `^` ranges |
| **D** | plugin/MCP malveillant | agents, Scrapling/Obscura/Postiz MCP | skills = instructions privilégiées, outils empoisonnés | agent ↔ outils | **aucun MCP/plugin tiers** dans Docteur ; Root Policy ; pin | environnement de dev de l'utilisateur (hors Docteur) |
| **E** | injection de prompt distante | Research, Investigator, Agency | page/e-mail/PDF instruisant le modèle | donnée ↔ prompt | **DATA ≠ instruction** (NB-4/5), contrat de réponse sans canal d'action, sortie vérifiée avant action | un modèle local peut produire du texte trompeur lu par l'humain |
| **F** | ancien historique IA empoisonné | AI History / Memory | texte stocké, désynchronisation vectorielle | import ↔ mémoire | rôle→confiance, `CONTEXT_ONLY`, bornes aléatoires, SQL fait foi (NB-6) | **exports réels non validés** ; PII |
| **G** | fichier/PDF/image malveillant | Document Toolbox, Bridge, Transfer | parseurs, JS PDF, pièces jointes | fichier ↔ outil | dossier jetable, limites, désactivation JS, pas d'exécution, tests de fixtures hostiles | CVE des parseurs (qpdf/pdfium/ffmpeg) → mises à jour **manuelles** et épinglées |
| **H** | appareil LAN non approuvé | QR Transfer, API en mode `LOCAL_NETWORK` | scan de ports, énumération d'ID | LAN ↔ listener | binding interface choisie, jeton 128 bits à usage unique, TTL, TLS ; **mode LAN actuel = API sans auth par utilisateur** (documenté) | acceptation d'un certificat auto-signé |
| **I** | QR code falsifié | QR Transfer | QR remplacé/affiché à un tiers | humain ↔ écran | afficher nom du fichier + empreinte courte + IP à confirmer ; jeton à usage unique ; QR affiché localement | « shoulder-surfing » photo du QR (TTL court) |
| **J** | provider cloud compromis | image/vidéo/TinEye/LLM cloud | fuite de prompts/images | Docteur ↔ cloud | Strict Local, `privacy-guard`, UPLOAD OFF, minimisation | fuite sur providers activés |
| **K** | extension navigateur compromise | Media Bridge | messages Native Messaging forgés | extension ↔ hôte | `allowed_origins` exact + ID épinglé, schéma strict, liste fermée d'actions, URL allowlist, quotas, **aucun cookie** | extension légitime mais compromise : peut mettre des URL en file (borné) |
| **L** | agent IA aux permissions excessives | external-agents, MetaGPT, Investigator, Agency, MCP | outil `exec`, écriture | agent ↔ exécuteurs | Root Policy, pas de shell, workspaces isolés, approbation liée au hash | modules gelés hors Root Policy |

### 23.2 Les 16 contrôles de sécurité (état **prouvé** ou non)

| # | Contrôle | État | Preuve / gap |
|---|---|---|---|
| 1 | Couper/borner les appels API longs | **PARTIEL** | corps bornés par route (NB-7), timeouts par module (code-intel 8 s, ripgrep, OMEGA/RASSILON) ; pas d'audit exhaustif de chaque `fetch` — UNKNOWN |
| 2 | Empêcher la fuite vers une IA | **PARTIEL (solide)** | `privacy-guard.js`, `strict-local.js`, `secret-scan`, tests NB-6 « 0 secret leakage » ; pas de garde unique sur *tous* les sortants |
| 3 | Vérifier les réponses IA avant action sensible | **PARTIEL** | approbation liée au hash (MetaGPT), contrats sans action (Notebook), MAÎTRE ; pas transverse |
| 4 | Limiter les droits des IA | **PARTIEL** | external-agents read/edit sans shell ; pas de Root Policy |
| 5 | Ne rien exposer de sensible au navigateur | **PARTIEL** | clés en DPAPI côté serveur ; absence de CSP ; contenu exposé au frontend non audité ici — UNKNOWN |
| 6 | Empêcher les redirections libres | **GAP RÉEL** | 4 `fetch` en `redirect:'follow'` sans re-validation |
| 7 | Protéger authentification et connexions | **PARTIEL** | OMEGA/RASSILON : Ed25519, certificats épinglés, TLS obligatoire ; API principale sans auth utilisateur (modèle « même compte Windows ») ; mode LAN = TLS mais pas d'auth par utilisateur |
| 8 | MFA/2FA pour services externes | **NON APPLICABLE** aujourd'hui | Docteur n'héberge pas de comptes ; relevant pour futurs connecteurs (laisser le MFA au fournisseur) |
| 9 | Ne pas révéler l'existence de comptes | **NON APPLICABLE** | pas de comptes |
| 10 | Empêcher le contournement des paiements | **NON APPLICABLE** aujourd'hui | à encoder en règle racine n°3 si Higgsfield/Postiz/Ads un jour |
| 11 | Double-clic / idempotence | **PARTIEL** | Sherlock (1 à la fois), DF (TOCTOU), OMEGA (nonces) ; idempotence UI générale UNKNOWN |
| 12 | Empêcher le rejeu | **PARTIEL** | nonces OMEGA/RASSILON LAN (`request_replay`) ; routes principales : garde CSRF, pas de nonce |
| 13 | Réduire les droits de déploiement | **NON APPLICABLE** | pas de déploiement ; Git : aucun push automatisé |
| 14 | Auditer le code externe | **RESPECTÉ** (pour OpenMontage, MetaGPT, Sherlock : rapports d'audit) | à reproduire pour tout nouveau tiers |
| 15 | Pinner versions/dépendances | **PARTIEL** | SHA pour externes, lockfiles ; `yt-dlp`/`ffmpeg` via PATH, npm `^` |
| 16 | Fail closed si composant de sécurité en panne | **PARTIEL** | garde NB-7 (Host mal formé ⇒ 403), DF `AGENT_ERROR` ; `strict-local` lit la base : comportement si lecture échoue UNKNOWN |

---

## 24. Decision matrix

Abréviations : V=VALUE (H/M/L) · SL=STRICT LOCAL (FULL/PART/CLOUD/UNK) · RISK (L/M/H/C/UNK) · P4S=PLUGIN4SHELL-LIKE (YES/NO/POSS/UNK) · INT=INTÉGRATION · P=phase.

### 24.1 Projets externes

| PROJECT | CATEGORY | V | OVERLAP | SL | CLOUD | LICENSE | SEC | SUPPLY | P4S | MAINT | WIN | INT | DECISION | PREREQ | BLOCKERS | P |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Open-Higgsfield | Media gen | M | image-router, OpenMontage | PART | requis (muapi) | MIT (+modèles) | M | M | POSS | actif, jeune | OK (NSIS) | idées | **ADAPT_IDEAS_ONLY** | — | dépôt canonique ? | P7 |
| Cap | Capture | M | useScreenShare | PART | optionnel | **AGPL** (+crates MIT) | M | M | POSS | UNK | OK | recréer | **RECREATE_NATIVE** | Root Policy | audio système | P7 |
| Auto-Editor | Montage | M | OpenMontage (partiel) | FULL (prob.) | non | Unlicense (+GPL bin) | M | M | POSS | actif (2-3 sem.) | UNK | sidecar CLI | **CONNECT_AS_SIDECAR** | pin + SHA + args typés | binaire Windows ? | P7 |
| TwitchNoSub | Référence | L | — | CLOUD | requis | Apache-2.0 | H | M | POSS | WIP | — | aucune | **REJECT** | — | contournement d'accès | — |
| OSIRIS | OSINT/géo | L-M | ≠ Observateur | PART | données distantes | MIT + par source | M-H | M | POSS | actif | Docker/Node | sources (idées) | **ADAPT_IDEAS_ONLY** | Egress Guard | scanner UNK, licences | P10+ |
| OpenPlanter | Investigation | M | Notebook, Sales, Sherlock | PART | optionnel | MIT | **C** (shell+écriture+web) | M | POSS | jeune | OK | idées | **ADAPT_IDEAS_ONLY** | Egress Guard, Root Policy | shell | P9 |
| God's Eye View | Géo | L | aucun | CLOUD | requis | MIT + données/tuiles NC | M | M | POSS | actif, non durci | Node | idées | **ADAPT_IDEAS_ONLY** | Egress Guard | NC, DATA_SOURCES | P10+ |
| TinEye | Image inversée | M | aucun | CLOUD | requis | API propriétaire | M | L | NO | actif | n/a | provider | **DEFER** | Investigator, UPLOAD OFF | ToS non lues | P9+ |
| Namechk | Marque | L | Sherlock | CLOUD | requis | propriétaire | L | L | NO | UNK | n/a | idées | **ADAPT_IDEAS_ONLY** | — | — | P10 |
| Cover Your Tracks | Vie privée | L | Strict Local, Observateur | PART | partiel | **AGPL** | M | M | POSS | modeste | Docker | idées | **ADAPT_IDEAS_ONLY** | — | AGPL | P10 |
| Scrapling | Scraping | L-M | deep-capture | PART | — | BSD-3 | **H** | **H** | POSS | très actif | OK | idées | **ADAPT_IDEAS_ONLY** | Egress Guard | stealth, pas de SSRF doc | P0 (idée) |
| Obscura | Headless | L | Playwright | PART | — | Apache-2.0 | **H** | **H** | POSS | jeune, 104 issues | zip OK | sidecar plus tard | **DEFER** | OS sandbox, Root Policy | issues SSRF/cookies ; stealth | — |
| Memos | Notes | L | **Notebook (fort)** | FULL (prob.) | non | MIT | M | L-M | POSS | actif | UNK | idées | **ADAPT_IDEAS_ONLY** | — | Notebook gelé | — |
| Chatwoot | Support | L | Sales (partiel) | CLOUD | requis | MIT + enterprise | **H** (CVE) | M | POSS | actif | Docker/WSL | sidecar plus tard | **DEFER** | besoin réel, Root Policy | Rails/PG/Redis, phone-home | P8+ |
| Postiz | Social | L | Sales (brouillon) | CLOUD | requis | **AGPL** | **H** (jetons) | M | POSS | actif | UNK | sidecar plus tard | **DEFER** | Root Policy, coffre | AGPL, jetons, MCP | P8+ |
| GetHuman | Support | L | notes | CLOUD | requis | propriétaire | L | L | NO | — | n/a | idées | **ADAPT_IDEAS_ONLY** | — | — | P10 |
| Show Me The Money | Agents/biz | L-M | Sales, Skills | CLOUD | requis | **CC BY-NC** | **H** | **H** | **YES** | actif | n/a | aucune | **REJECT** | — | licence, update non vérifié | — |
| PDF24 | PDF | M | pdf-parse, pdf.js | UNK | web : oui | freeware propriétaire | M | M | POSS | actif | natif Win | checklist | **ADAPT_IDEAS_ONLY** | — | non embarquable | P4 (idées) |
| IsThereAnyDeal | Prix jeux | L | aucun | CLOUD | requis | conditions d'API | L | L | NO | actif | n/a | module isolé | **DEFER** | Root Policy | — | P10 |
| MyFridgeFood | Recettes | L | aucun | CLOUD | requis | propriétaire | L | L | NO | — | n/a | aucune | **REJECT** | — | scope creep | — |
| FilePizza | Transfert | L (LAN) | aucun | PART | signalisation/STUN par défaut | BSD-3 | M | M | POSS | actif | navigateur | idées | **ADAPT_IDEAS_ONLY** | — | STUN/PeerJS tiers | — |
| qrcp | Transfert | M | aucun | FULL | non | MIT | M (pas d'auth) | L | POSS | actif | OK | idées | **ADAPT_IDEAS_ONLY** | — | HTTP clair, pas de jeton | — |

### 24.2 Fonctionnalités internes

| FEATURE | CATEGORY | V | OVERLAP | SL | CLOUD | SEC | SUPPLY | WIN | INT | DECISION | PREREQ | BLOCKERS | P |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Web Egress Guard + Research Adapter | Web | **H** | `url-security`, deep-capture | PART | sortant | **H (gaps actuels)** | L | OK | natif | **BUILD_NATIVE** | — | — | **P0** |
| Root Policy V1 | Core | **H** | 11 politiques verticales | FULL | non | M (SPOF) | L | ACL | natif | **BUILD_NATIVE** | P0 | conception signature/ACL | **P1** |
| Runtime Supervisor | Runtime | **H** | `.bat`, port-preflight | FULL | non | M | L | Job Objects : helper | natif | **BUILD_NATIVE** | P1 | parent séparé | **P2** |
| AI History / Memory Import | Mémoire | **H** | NB-4→NB-7 | FULL | non | M | L | OK | existant | **CONNECT_EXISTING** (+AUDIT_FURTHER) | exports réels | PII, chiffrement | **P3** |
| Document Toolbox | Documents | **H** | pdf-parse, pdf.js | FULL | non | M | M | OK | libs/CLI | **BUILD_NATIVE** | P1, pins | caviardage/signature | **P4** |
| Browser Media Bridge | Media | **H** | ytdlp | PART | source | **H** | M | NM registre | NM | **BUILD_NATIVE** (conditionnel) | P0, P1, **extension** | code extension UNKNOWN | **P5** |
| QR File Transfer | Transfert | M-H | aucun | FULL | non | M-H | L | pare-feu (invite) | natif | **BUILD_NATIVE** | P1 | TLS téléphone | **P6** |
| Media Studio (Recorder + Auto-Editor) | Media | M | OpenMontage, whisper | PART | opt | M | M | OK | pipeline | **CONNECT_EXISTING** + BUILD_NATIVE (Recorder) | P1 | — | **P7** |
| Agency (envoi explicite) | Business | M | Sales V1 | PART | opt | **H** (envoi) | M | OK | natif | **CONNECT_EXISTING** + BUILD_NATIVE (approbation/envoi) | **P1** | — | **P8** |
| Investigator | OSINT | M | Notebook | PART | opt | H | M | OK | natif | **AUDIT_FURTHER** | P0, P1, cas d'usage | besoin non posé | P9 |
| Code Intelligence | Dev | M | **existant** | FULL | non | L | L | OK | existant | **CONNECT_EXISTING** | — | — | hors roadmap |
| ReverseImageProvider | Investigation | L-M | aucun | FULL/CLOUD | opt | M | L | OK | abstraction | **DEFER** | Investigator | — | P9+ |
| Brand Presence | Marque | L | Sherlock | PART | RDAP | L | L | OK | natif | **DEFER** | P0 | — | P10 |
| Privacy Diagnostic | Vie privée | L | Strict Local | FULL | non | L | L | OK | natif | **DEFER** | — | — | P10 |
| Game Price Watch | Utilitaire | L | aucun | CLOUD | requis | L | L | OK | module | **DEFER** | P1 | — | P10 |
| Support Helper | Utilitaire | L | Todo/Notebook | FULL | non | L | L | OK | notes | **DEFER** | — | — | P10 |
| Pantry / Recipe | Utilitaire | L | aucun | FULL | non | L | L | OK | — | **REJECT** | — | scope creep | — |
| Geo/Event layers | Veille | L | ≠ Observateur | CLOUD | requis | M | L | OK | connecteurs | **AUDIT_FURTHER** | P0 | licences de données | P10+ |
| Docteur Arcade | Divertissement | L | aucun | FULL | non | M | L | OK | iframe isolée | **DEFER** | P1 | scope creep | P11 |

---

## 25. Proposed roadmap

### 25.1 Validation de l'ordre du prompt

| Ordre proposé (prompt) | Verdict | Justification factuelle |
|---|---|---|
| 1 ROOT POLICY | **Validé, mais précédé de P0** | La Root Policy n'a de valeur que si les exécuteurs l'appellent ; le premier risque démontré est ailleurs : le garde SSRF actuel est contournable (`[::ffff:127.0.0.1]`, mesuré). |
| 2 RUNTIME SUPERVISOR | **Validé** | dépend de l'action sémantique `RESTART_SERVICE` ; exige un processus parent séparé. |
| 3 AI HISTORY / MEMORY IMPORT | **Re-cadré** | **déjà construit** (NB-4→NB-7). Reste : export réel, PII, chiffrement → petite mission de validation. |
| 4 EXTERNAL PROJECTS SELECTED | **Réduit** | l'audit n'en retient qu'**un** en sidecar (Auto-Editor). |
| 5 CODE INTELLIGENCE | **Retiré** | déjà livré en lecture seule (certifié). |
| 6 BROWSER MEDIA BRIDGE | **Validé, conditionnel** | exige le code de l'extension (UNKNOWN) + P0 + P1. |
| 7 QR FILE TRANSFER | **Validé** | indépendant des modules gelés ; besoin de P1. |
| 8 AGENCY | **Après Media Studio** | Sales V1 existe ; l'étape d'envoi exige P1 ; surface externe plus risquée que Media. |
| 9 MEDIA STUDIO | **Avant Agency** | local, incrémental sur l'existant. |
| 10 utilitaires | Validé | DEFER individuels. |
| 11 Docteur Arcade | Validé (dernier) | valeur faible, scope creep. |
| *(nouveau)* Document Toolbox | **Inséré en P4** | valeur H, risque faible, 100 % local, sans inconnues bloquantes. |

### 25.2 Feuille de route

| Phase | Contenu | Entrée | Sortie / preuve attendue | Taille relative |
|---|---|---|---|---|
| **P0** | **Web Egress Guard** (SSRF/rebinding/redirections/taille/MIME) ; épinglage `yt-dlp`/`ffmpeg` (chemin + SHA-256) ; **décisions utilisateur** : commit du Notebook (jamais `git add -A` : dépôts imbriqués), mission « parité du garde NB-7 sur les 168 routes gelées » (unfreeze explicite) | — | corpus SSRF passé ; 0 `fetch` hors garde | M |
| **P1** | **Root Policy V1** : moteur de décision, registre d'actions, primitive d'approbation, politique signée + audit chaîné, test statique « aucun exécuteur sans `enforce()` » ; appliquée aux **nouveaux** exécuteurs | P0 | décisions testées, altération détectée, fail closed | L |
| **P2** | **Runtime Supervisor** (parent séparé, liste fermée, backoff, états) | P1 | crash simulé → relance bornée ; 0 shell | M |
| **P3** | **AI History : validation réelle** (export fourni par l'utilisateur, validateur existant) + PII + décision chiffrement (parallélisable) | exports | PASS/FAIL anonymisé par fournisseur | S |
| **P4** | **Document Toolbox** (fusion/découpe/rotation/images↔PDF/extraction/numérotation/filigrane/OCR local ; compression qpdf) | P1, pins | tests hostiles + réseau bloqué | M |
| **P5** | **Browser Media Bridge** (Native Messaging) | P0, P1, **code de l'extension** | schéma strict, ID épinglé, 0 listener | M-L |
| **P6** | **QR File Transfer** | P1 | tests §11.8 + test physique | M |
| **P7** | **Media Studio** : Recorder natif + Auto-Editor sidecar + `MediaProvider` | P1, P4/P5 optionnels | pipeline `Recorder → Auto-Editor → export` | M |
| **P8** | **Agency** : approbation commune + action d'envoi explicite (un canal) | P1 | 0 envoi sans approbation liée au hash | M |
| **P9** | **Investigator** (si cas d'usage) + `ReverseImageProvider` local | P0, P1 | revue humaine obligatoire | L |
| **P10** | Utilitaires optionnels (Brand Presence, Privacy Diagnostic, Game Price, Support Helper, Geo layers) | selon demande | — | S chacun |
| **P11** | Docteur Arcade (original, isolé) | P1 | iframe sans accès | S-M |

Règles de séquencement : une phase = **une mission** avec son propre gel ; aucune modification des modules gelés sans mission d'unfreeze ; chaque nouvel exécuteur « branche » la Root Policy dès sa première version ; P5 peut passer avant P4 si l'utilisateur fournit l'extension et le souhaite (seules dépendances : P0, P1).

---

## 26. Deferred / rejected items

| Élément | Décision | Raison courte | À rouvrir si… |
|---|---|---|---|
| Obscura | DEFER | marginal vs Playwright ; issues SSRF/cookies ouvertes ; stealth ; pas d'isolation OS | besoin de crawl lourd **et** bac à sable Windows disponible |
| Chatwoot | DEFER | pas de besoin support ; Rails+PG+Redis ; CVE 2026 ; phone-home | l'utilisateur gère de vrais clients |
| Postiz | DEFER | jetons OAuth, AGPL, MCP | publication régulière + Root Policy |
| TinEye (comme provider) | DEFER | coût/confidentialité ; usage non posé | Investigator actif |
| Game Price Watch | DEFER | valeur faible | demande explicite |
| Brand Presence / Privacy Diagnostic / Support Helper | DEFER | valeur faible | demande explicite |
| Twitch (contenus de compte) | DEFER | exige authentification que Docteur ne gère pas | conception d'un flux d'auth légitime |
| Redaction/signature PDF, conversion Office | DEFER | risques (faux caviardage, PKI) | besoin avéré |
| LSP / références complètes (Code Intel) | DEFER | processus tiers supplémentaire | besoin réel |
| Docteur Arcade | DEFER | scope creep | temps libre |
| TwitchNoSub | **REJECT** | contournement d'accès (règle racine n°3) | jamais |
| Show Me The Money | **REJECT** | CC BY-NC + Plugin4Shell-like YES + actions externes autonomes | — |
| MyFridgeFood / Pantry | **REJECT** (module) | scope creep | — |
| Préservation de jeux (Minion Rush, Cut the Rope) | hors périmètre | aucune fonction légitime à ajouter | — |

---

## 27. Unknowns

| # | UNKNOWN | Conséquence | Comment le lever |
|---|---|---|---|
| U1 | **Code de l'extension navigateur de l'utilisateur** | Media Bridge non conçu sur code réel | fournir le dossier de l'extension |
| U2 | **Exports réels ChatGPT/Claude/Gemini** | adapters SYNTHETIC_ONLY | `node nb7-validate-real-export.mjs <fichier>` (anonymisé) |
| U3 | LICENSE bruts non lus (résumés WebFetch) | risque de mauvaise lecture | lire `LICENSE`/`NOTICE` au commit épinglé |
| U4 | Dernières releases/dates (plusieurs UNKNOWN) | maintenance mal jugée | `git log`/releases au moment de l'audit de code |
| U5 | **Aucun code tiers lu ligne à ligne** | risques shell/FS dérivés de la doc | audit de code sur commit exact avant installation |
| U6 | OSIRIS `SCANNER_URL` (« reconnaissance toolkit ») | fonction possiblement offensive | auditer avant de s'en approcher (non requis si rejeté) |
| U7 | TinEye ToS / rétention d'images | confidentialité | lire `tineye.com/terms` |
| U8 | Auto-Editor : Windows (binaire), `--edit` (évaluation d'expressions ?), télémétrie, checksums | sidecar | audit du commit épinglé |
| U9 | Obscura : releases signées ? issues #1053/#1056 corrigées ? | décision DEFER | relecture à la réévaluation |
| U10 | Comment le téléphone fait-il confiance au certificat LAN existant ? | conception TLS du QR Transfer | lire `scripts/gen-cert.mjs` + `start-mobile.bat` complet |
| U11 | Idempotence UI / `strict-local` en cas d'échec de lecture de base | contrôles 11 et 16 | audit ciblé |
| U12 | Suites de tests **non relancées** par moi | je rapporte les chiffres des rapports | exécuter dans une mission de certification |
| U13 | Frontend : exposition de secrets/état sensible au navigateur (contrôle 5) | — | audit dédié |
| U14 | Tarball npm `@orrisai/show-me-the-money@2.8.0` ≟ `master` | (sans objet si REJECT) | — |
| U15 | Statut juridique des téléchargements (ToS plateformes, droit de copie privée) | risque contractuel | avis juridique |

---

## 28. Final checkpoint

```
MASTER EXTERNAL + FEATURES AUDIT

Docteur baseline inspected: YES — main @ 3eb24c4 (2026-09-29), 146 entrées git status (20 modifiées, 126 non suivies), rapports de certification lus, garde-fous lus ; 71 fichiers du gel Notebook vérifiés (drift 0)
Device Fabric V1 status: PASS — FROZEN (DEVICE_FABRIC_V1_FINAL_CERTIFICATION, 2026-09-24) ; fichiers commités, 0 modification ; suites NON relancées (UNKNOWN en re-exécution)
Device Fabric V2 status: FINAL — CERTIFIED — FROZEN (rapport 2026-09-29) ; fichiers commités, 0 modification ; second appareil réel NOT_RUN
Notebook status: FROZEN et vérifié par manifeste SHA-256 (NB-7, 274/274 selon rapport) — **mais au moins 42 fichiers NON COMMITÉS** ; adapters d'import SYNTHETIC_ONLY

Open-Higgsfield: ADAPT_IDEAS_ONLY (abstraction multi-provider déjà dans image-router ; muapi.ai requis ; clé en localStorage)
Cap: RECREATE_NATIVE (AGPL ; crates cap-camera*/scap-* MIT ; recorder natif getDisplayMedia/MediaRecorder)
Auto-Editor: CONNECT_AS_SIDECAR (Unlicense ; binaire GPL embarqué ; args typés, pin + SHA-256)
OSIRIS: ADAPT_IDEAS_ONLY (MIT code, licences de données par source ; ≠ Observateur)
OpenPlanter: ADAPT_IDEAS_ONLY (run_shell + write_file + fetch_url : incompatible ; idées evidence/graph)
Chatwoot: DEFER (Rails/PG/Redis, CVE 2026, phone-home)
GetHuman: ADAPT_IDEAS_ONLY (propriétaire ; pas de base à copier)
FilePizza: ADAPT_IDEAS_ONLY (STUN Google + PeerJS cloud par défaut ; LAN via HTTPS local plus simple)
Postiz: DEFER (AGPL, jetons OAuth, MCP)
Namechk: ADAPT_IDEAS_ONLY (RDAP + Sherlock)
Cover Your Tracks: ADAPT_IDEAS_ONLY (AGPL ; collecte d'empreinte serveur)
TinEye: DEFER (cloud, payant, ToS non lues ; abstraction ReverseImageProvider)
PDF24: ADAPT_IDEAS_ONLY (freeware propriétaire, composants non réutilisables ; Document Toolbox natif)
IsThereAnyDeal: DEFER (API clé, 1000/5 min, valeur faible)
MyFridgeFood: REJECT (module ; scope creep)
Memos: ADAPT_IDEAS_ONLY (aucun apport vs Notebook)
Show Me The Money: REJECT (CC BY-NC ; postinstall + /money-upgrade ; Plugin4Shell-like YES)
Obscura: DEFER (jeune, issues SSRF/cookies ouvertes, stealth, pas d'isolation OS)
God's Eye View: ADAPT_IDEAS_ONLY (données/tuiles à termes séparés NC ; cloud requis)
Scrapling: ADAPT_IDEAS_ONLY (stealth/Turnstile = contournement ; pas de garde SSRF documentée)
TwitchNoSub reference audit: REJECT — référence seulement, mécanisme non documenté ni repris ; leçons d'architecture générales uniquement

Existing browser extension code inspected: NO — non fournie (UNKNOWN)
Browser Media Bridge feasibility: FEASIBLE techniquement (Native Messaging, allowed_origins exact, aucun listener) — BLOCKED sur UNKNOWN U1
Discord integration feasibility: FEASIBLE via extension (URL de pièce jointe visible) ; API avec jeton utilisateur INTERDITE
YouTube integration feasibility: FEASIBLE (yt-dlp déjà présent ; action manuelle)
Twitch legitimate-access integration feasibility: FEASIBLE_PARTIAL (VOD/clips publics) ; contenus de compte non pris en charge V1

AI History Import feasibility: FEASIBLE — DÉJÀ IMPLÉMENTÉ (NB-4→NB-7) ; validation réelle NOT_RUN
ChatGPT export: adapter existant (conversations.json + mapping) — SYNTHETIC_ONLY
Claude export: adapter existant (chat_messages/sender) — SYNTHETIC_ONLY
Gemini export: FEASIBLE_PARTIAL (Takeout MyActivity, journal d'activité) — SYNTHETIC_ONLY
Memory/RAG poisoning protections: PRÉSENTES et testées sur données synthétiques (rôle→confiance, CONTEXT_ONLY, bornes aléatoires, SQL fait foi, contrat sans action) ; GAPS : exports réels, PII, chiffrement au repos

QR File Transfer feasibility: FEASIBLE (HTTPS éphémère LAN, jeton à usage unique)
Large file support feasibility: FEASIBLE (flux + Range ; tests ≥ 4 Gio requis)
Resume feasibility: FEASIBLE (Range + .part + hash)
Encryption feasibility: FEASIBLE via TLS ; point ouvert U10 (confiance du certificat sur téléphone)
One-use QR/token feasibility: FEASIBLE (≥128 bits, usage unique, TTL)

Root Policy feasibility: FEASIBLE
Root Policy code enforcement: OUI — jeton d'autorisation lié à l'action vérifié par l'exécuteur ; couverture = nouveaux exécuteurs ; modules gelés non couverts jusqu'à unfreeze (franchise)
Root Policy AI modification allowed: NON
Root Policy tamper detection: OUI — signature (clé privée hors Docteur), hash, version anti-rollback, audit chaîné, ACL ; limite : administrateur complet de la machine
Root Policy fail-closed feasibility: OUI

Runtime Supervisor feasibility: FEASIBLE (processus parent séparé requis)
Arbitrary shell required: NON
Semantic service allowlist feasible: OUI

Code Intelligence feasibility: DÉJÀ LIVRÉ en lecture seule (CERTIFIED GREEN, 78/78 selon rapport) ; tree-sitter/blame = AUDIT_FURTHER
Agency feasibility: FEASIBLE pour DRAFT/REVIEW (Sales V1 existant) ; envoi explicite = après Root Policy
Media Studio feasibility: FEASIBLE par étapes (MediaProvider/MediaPipeline, pas de monolithe)

Minion Rush preservation analysis: hors périmètre / aucune fonction légitime à ajouter (client Windows défunct ; voies officielles ; pas de DRM/serveur)
Minion Rush clean-room recreation: FEASIBLE mais DEFER (univers/assets/code originaux ; rien de Gameloft/Illumination)
Cut the Rope preservation analysis: hors périmètre (versions HTML5 officielles ; Remastered fermé en 2024)
Cut the Rope clean-room recreation: FEASIBLE mais DEFER (aucune copie d'Om Nom, niveaux, assets)

Plugin4Shell/supply-chain audit coverage: 24 projets/fonctions externes + 1 inconnu (extension) ; Docteur lui-même (pins, lockfiles, PATH)
High-risk external install scripts found: 1 confirmé (Show Me The Money postinstall: node install.js — copie-only sur master, tarball non vérifié) ; à risque : Scrapling `scrapling install`, Obscura `curl | tar`, God's Eye View (Pinokio) ; AUCUN exécuté
MCP risks identified: Scrapling MCP, Obscura MCP (14 outils), Postiz MCP ; CVE-2026-81848 (SSRF) dans scrapling-fetch-mcp tiers ; empoisonnement d'outils/skills ; AUCUN installé
Shell risks identified: OpenPlanter run_shell/run_shell_bg ; shell interactif Scrapling ; .bat `cmd /k` (humain) ; secret-store PowerShell -ExecutionPolicy Bypass (valeurs en base64)
Auto-update risks identified: Show Me The Money /money-upgrade ; Plugin4Shell (corrigé CC ≥ 2.1.179 ; installé 2.1.269) ; extensions de navigateur ; Tauri/PDF24 updaters (UNKNOWN) ; ChatwootHub

Strict Local compatibility reviewed: YES (par projet, §7/§21)
Cloud dependencies reviewed: YES (§21)
Secrets reviewed: YES (§22) — aucun secret trouvé ni manipulé
Licenses reviewed: YES (résumés `[WEB-P]`, LICENSE bruts non lus — U3)
Telemetry reviewed: YES où documenté ; UNKNOWN pour plusieurs projets (indiqué)
Network destinations reviewed: YES (§21)
Prompt injection reviewed: YES (§5.3, §10, §15, §23)
SSRF reviewed: YES — **faille réelle** dans url-security.js (IPv4-mappé IPv6, DNS, CGNAT, fd* faux positif) + 4 redirects non revalidés
Browser security reviewed: YES (Native Messaging, MV3, CSP absent, garde NB-7, 168 routes exemptées)

Recommended integrations: aucune intégration directe
Recommended sidecars: Auto-Editor
Recommended native recreations: Web Egress Guard, Root Policy, Runtime Supervisor, Document Toolbox, Browser Media Bridge (conditionnel), QR File Transfer, Recorder
Adapt ideas only: Open-Higgsfield, OSIRIS, OpenPlanter, God's Eye View, Namechk, Cover Your Tracks, Scrapling, Memos, GetHuman, PDF24, FilePizza, qrcp
Deferred: Obscura, Chatwoot, Postiz, TinEye, IsThereAnyDeal, Brand Presence, Privacy Diagnostic, Support Helper, Arcade, contenus Twitch de compte
Rejected: TwitchNoSub, Show Me The Money, MyFridgeFood (module)

Docteur functional code modified: 0
Frozen modules modified: 0
External projects installed: 0
External repositories executed: 0
Dependencies installed: 0
Plugins installed: 0
MCP servers installed: 0
External binaries executed: 0   (exécutés : git/ls/grep lecture, node pour un script de Docteur en lecture et un `new URL()`, `claude --version` ; aucun binaire d'un projet audité)
Network configuration modified: 0

Report:
reports/DOCTEUR_MASTER_EXTERNAL_FEATURES_AUDIT_2026-10.md

FINAL AUDIT STATUS:
PASS_WITH_UNKNOWNS
```

STOP — fin de mission. Aucune implémentation n'est commencée ; en attente d'une nouvelle instruction humaine.
