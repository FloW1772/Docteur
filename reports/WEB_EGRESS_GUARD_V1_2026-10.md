# DOCTEUR — WEB EGRESS GUARD V1

Date : 2026-10-01 · Mission : sécurité / implémentation / certification · Priorité P0 · Branche `main` @ `3eb24c4` (+ travail non commité d'autres missions)
Rapport source : `reports/DOCTEUR_MASTER_EXTERNAL_FEATURES_AUDIT_2026-10.md` (§1.4, §5.4, §23.2 contrôle 6).

Aucune action git d'écriture (`add`/`commit`/`push`/`reset`/`clean`/`stash`). Aucun module FROZEN modifié (vérifié par test statique + `git status`). Aucune dépendance ajoutée.

Tags de preuve : `[MESURÉ]` exécuté dans cette mission ; `[CODE]` lu dans le code ; `[DOC]` documentation officielle/standard citée pour un fait d'environnement.

---

## 1. Executive summary

**Statut final : `PASS_WITH_LIMITATIONS`** (checkpoint §23). Limites : `yt-dlp` (processus externe) protégé statiquement seulement ; premier saut des fournisseurs à hôte constant non épinglé.

* Un garde **central** (`cortex-server/src/lib/web-egress-guard.js`) remplace la validation par préfixes de chaîne : parseur URL standard uniquement, classification des adresses **par octets** (IPv4 + IPv6, y compris les formes IPv4 embarquées), résolution DNS **de toutes les adresses**, connexion **épinglée** sur une adresse validée (Host/SNI/vérification de certificat restent ceux du nom d'hôte), redirections **suivies manuellement et revalidées à chaque saut**, plafonds de taille (décompression incluse), délais, journalisation structurée sans secret.
* Le contournement d'origine (`http://[::ffff:127.0.0.1]/`) est **corrigé comme classe** : 39 sondes avant/après (§3), plus 54 tests unitaires de matrice (formes mappées, compatibles IPv4, NAT64, 6to4, multicast, CGNAT, metadata, bornes RFC1918…) et un test de parité contre les classificateurs certifiés de Sherlock et Cyber Audit.
* **Le périmètre réel était plus large que « 4 fetch ».** `fetch()` suit les redirections **par défaut** : les chemins de capture d'article (`capture.js`, `deep-capture.js`), le catalogue/téléchargement Kiwix (dont l'URL du miroir vient d'un XML distant), la recherche web, les connecteurs Drive/OneDrive et surtout **la navigation Chromium** (`deep-capture`, export PDF) suivaient aveuglément les redirections. Au total **16 points d’appel migrés** (§17).
* **Le harnais réel a trouvé une faille dans ma première version** : un filtre Playwright `context.route()` ne voit **pas** les sauts de redirection suivis par Chromium (un redirect public→interne atteignait la cible, `/secret` reçu). Correction à la bonne couche : un **proxy sortant local** (loopback, identifiants aléatoires) que Chromium est forcé d'utiliser ; il valide et épingle chaque connexion (redirections, sous-ressources, scripts de page, HTTPS via CONNECT). Preuve : `connections_received = 0` sur la cible interne, avec un contrôle positif (même navigation sans proxy → la cible est atteinte).
* Les services locaux de confiance (Ollama, kiwix-serve, ComfyUI, PAIR, API Docteur) et les protocoles certifiés (OMEGA, RASSILON, Device Fabric, MAÎTRE) **ne sont pas** routés par le garde (test statique) ; Sherlock et Cyber Audit gardent leurs passerelles épinglées d'origine.
* Limites documentées (§21) : processus externes (`yt-dlp`) validés statiquement seulement (PARTIAL) ; premier saut des fournisseurs à hôte constant via `fetch` du runtime (non épinglé) ; ports standards 80/443 uniquement (changement de comportement assumé).

---

## 2. Original audit finding

`reports/DOCTEUR_MASTER_EXTERNAL_FEATURES_AUDIT_2026-10.md` §1.4 : `assertSafeUrl` laissait passer `http://[::ffff:127.0.0.1]/` ; aucune résolution DNS ; 4 `fetch(..., { redirect: 'follow' })` sans revalidation (`image.js:64`, `comfyui-install-manager.js:258`, `comfyui-model-manager.js:80`, `free-ai-catalog.js:112`) ; `h.startsWith('fd')` bloquant à tort `fdic.gov`.

**Corrections et compléments à ce constat** (le rapport d'audit est « un point de départ ») :

| Point | Constat de cette mission |
|---|---|
| « 4 fetch » | **Sous-estimé** : tout `fetch(url)` sans option `redirect` suit aussi les redirections. Cartographie complète au §5. |
| « aucune résolution DNS » | Vrai pour `url-security.js` ; **faux pour l'ensemble de Docteur** : `cyber-gateway.js` (Observateur) et `sherlock-policy.js` résolvent le DNS, **épinglent** l'adresse dans la socket et revalident chaque redirection. Le rapport d'audit ne les créditait pas. Elles servent de modèle ; leur classificateur (liste blanche IPv6) est correct mais **sur-bloque** certains espaces publics (`192.0.0.0/16` entier, `2001::/16` entier). |
| Navigation Chromium | Non identifiée par l'audit : `page.goto` et les sous-ressources suivent les redirections avec le DNS de Chromium. Nouveau chemin vulnérable (deep-capture + export PDF). |
| Kiwix | L'URL du miroir de téléchargement provient d'un XML **distant** (metalink) puis était récupérée avec `fetch` par défaut après une simple vérification statique. |

---

## 3. Reproduction of the IPv4-mapped IPv6 bypass

`[MESURÉ]` avant correction — `assertSafeUrl` appelé sur 39 URL (script `baseline-probe.mjs`, aucun réseau) :

| URL | Avant | Après (garde central) |
|---|---|---|
| `http://[::ffff:127.0.0.1]/` (**payload d'origine**) | **ALLOWED** | `BLOCKED_LOOPBACK` |
| `http://[::ffff:7f00:1]/` (forme canonique du parseur) | **ALLOWED** | `BLOCKED_LOOPBACK` |
| `http://[::ffff:10.0.0.1]/`, `…192.168.1.1]/` | **ALLOWED** | `BLOCKED_PRIVATE` |
| `http://[::ffff:169.254.169.254]/` | **ALLOWED** | `BLOCKED_METADATA` |
| `http://[::127.0.0.1]/` (IPv4-compatible) | **ALLOWED** | `BLOCKED_LOOPBACK` |
| `http://[64:ff9b::7f00:1]/` (NAT64) | **ALLOWED** | `BLOCKED_LOOPBACK` |
| `http://[2002:7f00:1::]/` (6to4) | **ALLOWED** | `BLOCKED_LOOPBACK` |
| `http://[::]/` | **ALLOWED** | `BLOCKED_UNSPECIFIED` |
| `http://100.64.0.1/` (CGNAT) | **ALLOWED** | `BLOCKED_PRIVATE` |
| `http://224.0.0.1/`, `http://[ff02::1]/` (multicast) | **ALLOWED** | `BLOCKED_MULTICAST` |
| `http://localhost./` (point final) | **ALLOWED** | `BLOCKED_LOCAL_NAME` |
| `http://metadata.google.internal/`, `http://intranet/` | **ALLOWED** | `BLOCKED_LOCAL_NAME` |
| `http://user:pw@example.com/` | **ALLOWED** | `BLOCKED_USERINFO` |
| `https://example.com:8443/`, `http://example.com:6379/` | **ALLOWED** | `BLOCKED_PORT` |
| `https://fdic.gov/` (public légitime) | **bloqué à tort** | autorisé |
| `http://127.0.0.1/`, `[::1]`, `2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1` | bloqué | `BLOCKED_LOOPBACK` (le parseur normalise ces formes) |
| `ftp:`, `file:`, `data:`, `gopher:`, `ws:` | bloqué | `BLOCKED_SCHEME` |

Cause : l'ancien code comparait des **préfixes de chaîne** sur le nom d'hôte normalisé par le parseur (`[::ffff:7f00:1]`), qui ne correspondait à aucun motif.

---

## 4. Existing egress architecture (avant la mission)

`[CODE]`

* **Pré-vérification statique** `assertSafeUrl` (`url-security.js`, 36 appelants) : préfixes de chaîne, pas de DNS, pas de contrôle de port ni de userinfo, pas de politique de redirection.
* **`fetch` direct** partout ailleurs : redirections suivies par défaut, DNS résolu par le runtime, corps lus sans plafond (`response.text()`, `arrayBuffer()` puis test de taille *après* téléchargement dans `image.js`).
* **Passerelles épinglées existantes** : `cyber-gateway.js` (Observateur, FROZEN) et `sherlock-policy.js` : `http(s).request` + `lookup` épinglé + revalidation par saut + plafond de taille. Deux classificateurs d'adresses **dupliqués** (`cyber-policy.isPublicAddress`, `sherlock-policy.publicAddress`).
* **Garde entrant** NB-7 (`local-request-guard.js`) : protège l'API locale contre les pages web (CSRF, DNS rebinding sur le `Host`). **Hors sujet** pour la sortie, mais même famille de menace.
* **Navigateur** : `chromium.launch` sans proxy (`deep-capture.js`, `pdf.js`).

---

## 5. Outbound callsite inventory (Phase 0)

Recherche : `fetch(`, `node-fetch`, `https?.request|get`, `net|tls.connect`, `WebSocket`, `EventSource`, `undici`/`axios`/`got`, `chromium.launch`, processus externes (`yt-dlp`, `ffmpeg`, Python). **Aucun `axios`/`undici`/`got`/`WebSocket`/`EventSource`** dans `cortex-server/src` `[MESURÉ]`. Les numéros de ligne sont ceux **avant** la migration ; le test statique `test-web-egress-static-audit.mjs` fige désormais la liste exacte.

Colonnes : redirect = comportement des redirections *avant* ; DNS = qui résout *avant* ; borne = timeout / plafond de réponse *avant*.

### A — PUBLIC_EGRESS (doit passer par le garde)

| # | Fichier / fonction (ligne d'origine) | Destination | Source de l'URL | redirect | DNS | borne | Statut |
|---|---|---|---|---|---|---|---|
| A1 | `lib/capture.js` `fetchText` (134) ← 7 appelants (articles, GitHub API, oEmbed YouTube/X) | pages web | entrée utilisateur (+ API fixes) | **suivi aveugle** (défaut) | runtime | 8 s, **corps illimité** | **migré** |
| A2 | `lib/deep-capture.js` `httpFetch` (455) | pages web | utilisateur / résultats de recherche | **suivi aveugle** | runtime | `FETCH_TIMEOUT`, illimité | **migré** |
| A3 | `lib/deep-capture.js` `extractWithPlaywright` → `page.goto` + sous-ressources | pages web | idem | **suivi par Chromium** | **Chromium** | `PW_TIMEOUT` | **migré** (proxy) |
| A4 | `lib/image.js` `downloadImageFromUrl` (64) | images | utilisateur / pages | `redirect:'follow'` explicite | runtime | **aucune** limite avant lecture complète | **migré** |
| A5 | `routes/kiwix.js` `resolveMetalinkUrl` (34) | metalink Kiwix | corps de requête | suivi aveugle | runtime | 10 s, illimité | **migré** |
| A6 | `routes/kiwix.js` téléchargement ZIM (348) | miroir | corps de requête **ou XML distant** | suivi aveugle | runtime | signal client seulement | **migré** |
| A7 | `lib/pdf.js` `generatePdf` (Chromium) | tout ce que la note référence (images, liens, CDN) | **contenu de documents** | suivi par Chromium | Chromium | 10 s setContent | **migré** (proxy) |
| A8 | processus `yt-dlp` (`ytdlp.js` ×3, `video-audio-download.js`, `whisper.js` `getVideoDuration`, `youtube-discovery.js`) | sites vidéo | utilisateur | `yt-dlp` suit seul | `yt-dlp` | propres | **PARTIAL** (§21 L1) |
| A9 | `youtube-transcript` (lib) dans `deep-capture.js` | youtube.com | identifiant extrait par le parseur | lib | lib | lib | non migré : hôte constant, bibliothèque tierce |

### B — FIXED_EXTERNAL_PROVIDER (hôte externe constant)

| # | Fichier (ligne) | Destination | redirect avant | Statut |
|---|---|---|---|---|
| B1 | `lib/comfyui-install-manager.js` `downloadWithProgress` (258) | `github.com` (release ComfyUI) | `redirect:'follow'` explicite | **migré** `trustedHosts` |
| B2 | `lib/comfyui-model-manager.js` `runModelDownload` (80) | `huggingface.co` (catalogue constant) | `redirect:'follow'` explicite | **migré** `trustedHosts` |
| B3 | `lib/free-ai-catalog.js` `fetchCatalog` (110) | `raw.githubusercontent.com` | `redirect:'follow'` explicite | **migré** `trustedHosts` |
| B4 | `lib/kiwix-catalog.js` `searchCatalog` (19) | `library.kiwix.org` | suivi par défaut | **migré** `trustedHosts` |
| B5 | `lib/web-search.js` `searchDuckDuckGo` (20) | `html.duckduckgo.com` | suivi par défaut | **migré** `trustedHosts` |
| B6 | `server.js` oEmbed (1322), `deep-capture.js` oEmbed (736) | `www.youtube.com` | suivi par défaut | **migré** |
| B7 | `lib/connectors/google-drive-rate-limit.js` (13) | `www.googleapis.com` (+ redirections de téléchargement) | suivi par défaut | **migré** |
| B8 | `lib/connectors/onedrive-connector.js` `downloadFileContent` (via `download-limits.js`) | **URL pré-authentifiée émise par Graph** | suivi par défaut | **migré** (premier saut = l'hôte émis, https, jamais IP) |
| B9 | connecteurs : jetons OAuth (POST) ×5, API GET à base constante (YouTube, Graph) | Google / Microsoft | n/a (POST/API) | non migré (constantes, §21 L3) |
| B10 | `providers/anthropic|gemini|groq|openai|openrouter.js`, `whisper-groq.js` | API de fournisseurs IA (constantes) | n/a (POST, aucune URL variable) | non migré (§21 L3) |

### C — TRUSTED_LOCAL (services locaux, **non** routés par le garde)

`lib/providers/comfyui.js` (2), `providers/freellmapi.js` (1), `providers/pair.js` (`node-fetch`, 5), `routes/ollama.js` (3), `routes/local-ai.js` (1), `lib/kiwix-client.js` (2), `lib/kiwix.js` (1), `lib/maitre-host-isolation.js` (1, **FROZEN**). Points d'extrémité fixes (`127.0.0.1:port`) ou **configurés par l'utilisateur** dans les réglages (Ollama, ComfyUI, PAIR, FreeLLMAPI). Une règle « loopback interdit » les casserait.

### D — LAN / DEVICE COMMUNICATION (**non** touchés)

`lib/omega-outbound-network.js` (TLS épinglé), `lib/rassilon-controller.js` (TLS épinglé). Modules FROZEN.

### E — Passerelles épinglées préexistantes (SCOPED_GATEWAY)

`lib/cyber-gateway.js` (Observateur, FROZEN) et `lib/sherlock-policy.js` : DNS résolu et revalidé à chaque saut, adresse épinglée, 3 redirections (Sherlock) / `LIMITS.redirects` (Cyber). **Non migrées** (modules certifiés) ; parité vérifiée par test (§18).

### UNKNOWN

Aucun appel non classifiable. Observation annexe : `providers/pair.js` importe `node-fetch`, **absent** des `dependencies` de `cortex-server/package.json` (résolu uniquement par hoisting) — fragilité de chaîne d'approvisionnement, **non corrigée ici**.

---

## 6. Trust classifications

| Classe | Règle | Mécanisme |
|---|---|---|
| **A PUBLIC_EGRESS** | Destination influencée par utilisateur / document / IA / donnée distante | `safeFetch` (transport épinglé) ou proxy navigateur ; **aucun** `fetch` brut (test statique) |
| **B FIXED_EXTERNAL_PROVIDER** | Hôte constant | soit constantes sans composante d'URL variable (inchangé, listé), soit `safeFetch({ trustedHosts })` : **premier saut** par le `fetch` du runtime vers l'hôte listé (https, non IP, hors suffixes locaux) ; **tout saut de redirection** entièrement validé et épinglé |
| **C TRUSTED_LOCAL** | Service local typé | chemin propre, **non** routé ; défendu côté entrée par le garde NB-7 |
| **D DEVICE** | Protocole certifié | inchangé |
| **E SCOPED_GATEWAY** | Passerelle certifiée à portée déclarée | inchangée ; classificateur jamais plus faible que le central (test de parité) |

Le test statique impose aussi : aucun module gelé (`device-fabric*`, `omega*`, `rassilon*`, `maitre*`, `monitor*`, `notebook*`) n'importe le garde.

---

## 7. Threat model

| # | Vecteur | Chemin | Contrôle | Preuve |
|---|---|---|---|---|
| T1 | URL directe interne (`127.0.0.1`, `localhost`, `[::1]`) | A1-A7 | classification d'adresse + noms locaux | unitaire + harnais (0 connexion) |
| T2 | IPv4-mapped IPv6 & formes apparentées | A1-A7 | classification **par octets**, adresse embarquée jugée | 39 sondes, matrice, parité |
| T3 | Réseaux privés / link-local / CGNAT / multicast / non spécifié / réservés | idem | table IANA + liste blanche IPv6 | bornes avant/début/fin/après |
| T4 | Metadata cloud (AWS, GCP, Azure, Alibaba, Oracle, ECS, IPv6 AWS) | idem | catégorie `METADATA` prioritaire | unitaire |
| T5 | Hostname public → IP privée | A1-A6 | DNS : **toutes** les adresses validées | mock resolver |
| T6 | Réponse DNS mixte public + privé | idem | refus si **une** adresse est interdite | tests (3 ordres) |
| T7 | DNS rebinding / TOCTOU | idem | **une** résolution par saut, socket épinglée | tests (§12) |
| T8 | Redirect public → interne (1, 2, N sauts, schéma interdit, userinfo, port, nom local, `Location` malformée) | A1-A7 | manuel + revalidation + boucle + limite | fixtures réelles + harnais Chromium |
| T9 | Userinfo trompeur, nom d'hôte trompeur, casse, point final, crochets IPv6 | statique | parseur WHATWG, userinfo refusé, `localhost.example.com` laissé au DNS | unitaire |
| T10 | Ports inattendus | statique | 80/443 uniquement | unitaire |
| T11 | Schémas (`file`, `ftp`, `data`, `javascript`, `gopher`, `ws`, `wss`, `blob`, …) | statique | **liste blanche** `http`/`https` | unitaire |
| T12 | Réponse géante / bombe de décompression / ruissellement lent | safeFetch | plafond sur la taille **décodée**, délais en-têtes/inactivité/total | unitaire |
| T13 | Sous-ressources, XHR, iframes, redirections **dans Chromium** ; WebRTC | A3, A7 | proxy de sortie obligatoire + `disable_non_proxied_udp` | harnais Chromium réel |
| T14 | Fuite de secrets dans les logs | tout | journal = raison + nom d'hôte | test de log |
| T15 | Contournement par un second chemin | tout | test statique : tout `fetch`/`http.request` classé ; `redirect:'follow'` interdit ; lancement Chromium sans proxy interdit | test statique |

---

## 8. URL normalization policy

Pipeline appliqué à **chaque saut** : `INPUT → URL PARSE → NORMALIZATION → SCHEME/POLICY → HOST VALIDATION → DNS/ADDRESS → CONNECTION → REDIRECT → REVALIDATION → RESPONSE`.

| Étape | Règle | Code `BLOCKED_*` |
|---|---|---|
| Entrée | chaîne ou `URL`, ≤ 8 192 caractères, non vide | `INVALID_URL` |
| Parse | **uniquement** `new URL()` (WHATWG) — aucun parsing par regex. Les formes décimale/octale/hexadécimale/courte d'IPv4 (`2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`) sont normalisées par le parseur *avant* toute décision | `INVALID_URL` |
| Schéma | **liste blanche** `https:` et `http:` (`http:` désactivable par appel `allowHttp:false`) ; tout autre schéma refusé | `SCHEME` |
| Userinfo | `user:pass@` **toujours refusé** ; jamais journalisé | `USERINFO` |
| Hôte | minuscule, crochets IPv6 retirés, **un** point final retiré ; hôte vide, commençant/finissant par `.`, ou contenant `..` refusé | `INVALID_URL` |
| Hôte littéral IP | classé par octets (§9) | `LOOPBACK`/`PRIVATE`/… |
| Nom d'hôte | sans point (étiquette unique) → refusé ; suffixes `localhost`, `local`, `localdomain`, `internal`, `lan`, `home.arpa`, `intranet` → refusés. Un nom trompeur comme `localhost.example.com` est **public** pour le parseur : c'est le DNS qui décide | `LOCAL_NAME` |
| Port | **port effectif** (défaut du schéma si absent) ∈ {80, 443} | `PORT` |

Choix explicites : `username:password@` refusé ; schémas `ws/wss` refusés (aucun appelant) ; `http:` autorisé pour la lecture de pages (de nombreux articles n'ont pas HTTPS) mais la **redirection https→http est refusée** (§13).

## 9. IP classification policy

Source : registres IANA *IPv4 Special-Purpose Address Registry* et *IPv6 Special-Purpose Address Registry* (RFC 6890 et mises à jour) `[DOC]`. Classification **par octets**, jamais par préfixe de chaîne. Inconnu / non analysable ⇒ `RESERVED` (**fail closed**).

**IPv4** (première règle qui correspond ; les `/32` metadata précèdent les plages qui les contiennent)

| Plage | Catégorie |
|---|---|
| `0.0.0.0` | UNSPECIFIED · `0.0.0.0/8` autres : RESERVED |
| `10/8`, `172.16/12`, `192.168/16`, `100.64/10` (CGNAT, RFC 6598) | PRIVATE |
| `127/8` | LOOPBACK |
| `169.254/16` | LINK_LOCAL |
| `169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `192.0.0.192`, `168.63.129.16` | **METADATA** (AWS/GCP/Azure/OpenStack IMDS, ECS, Alibaba, Oracle, Azure WireServer) |
| `192.0.0.0/24`, `192.0.2/24`, `198.51.100/24`, `203.0.113/24` (documentation), `192.88.99/24`, `198.18/15`, `240/4` (dont `255.255.255.255`) | RESERVED |
| `224/4` | MULTICAST |

**IPv6** — politique de **liste blanche** : seul le *global unicast* `2000::/3` est public, moins les blocs spéciaux.

| Plage | Catégorie |
|---|---|
| `::` | UNSPECIFIED · `::1` LOOPBACK |
| `fe80::/10` | LINK_LOCAL · `fc00::/7`, `fec0::/10` PRIVATE · `ff00::/8` MULTICAST |
| `fd00:ec2::254` | METADATA (AWS IPv6) |
| `2001::/23` (Teredo, ORCHID…), `2001:db8::/32`, `3fff::/20` (documentation), tout le reste hors `2000::/3` (`100::/64`, `5f00::/16`, …) | RESERVED |
| `::ffff:0:0/96`, `::/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `2002::/16` | voir §10 |

Corrections par rapport aux classificateurs existants : `192.0.0.0/16` n'est plus bloqué en entier (seuls `192.0.0.0/24` et `192.0.2.0/24` le sont ; `192.0.43.8` = iana.org est public) ; `2001::/16` n'est plus bloqué en entier (`2001:4860::/32` = Google DNS est public ; `2001::/23` reste bloqué). Le test de parité vérifie que le garde central n'est **jamais plus faible** que `cyber-policy.isPublicAddress` et `sherlock-policy.publicAddress`, hors ces deux sur-blocages explicitement justifiés.

## 10. IPv4-mapped IPv6 handling

La classe complète est traitée, pas seulement `::ffff:127.0.0.1` :

| Forme | Traitement |
|---|---|
| `::ffff:a.b.c.d` / `::ffff:xxxx:xxxx` (mapped, `::ffff:0:0/96`) | IPv4 embarquée **jugée par les règles IPv4** : `::ffff:127.0.0.1` → `LOOPBACK`, `::ffff:10.0.0.1` → `PRIVATE`, `::ffff:169.254.169.254` → `METADATA`, `::ffff:0.0.0.0` → `UNSPECIFIED`, `::ffff:224.0.0.1` → `MULTICAST`. Une forme mappée d'une IPv4 **publique** (`::ffff:8.8.8.8`) est **refusée** (`RESERVED`) : aucun usage légitime côté Web, et tous les classificateurs certifiés de Docteur la refusent déjà |
| `::a.b.c.d` (IPv4-compatible, obsolète, `::/96`) | catégorie de l'IPv4 embarquée si non publique, sinon `RESERVED` |
| `64:ff9b::/96` (NAT64) et `64:ff9b:1::/48` | idem ; jamais public |
| `2002::/16` (6to4) | l'IPv4 aux octets 2-5 est jugée ; jamais publique |
| écritures (`::FFFF:127.0.0.1`, `0:0:0:0:0:ffff:7f00:0001`, queue décimale pointée) | un analyseur IPv6 maison (compression `::`, queue IPv4, 500 cas aléatoires aller-retour) produit les 16 octets ; refus de `1::2::3`, `12345::`, zone `%eth0`, etc. |

## 11. DNS validation

* Un **nom** est résolu par `dns.promises.lookup(host, { all: true, verbatim: true })` (résolveur système : fichier `hosts` respecté ; un `hosts` qui renverrait un nom public vers `127.0.0.1` est donc bloqué).
* **Toutes** les adresses renvoyées sont validées. Une seule adresse interdite (mélange public + privé, dans n'importe quel ordre) ⇒ `BLOCKED_DNS_PRIVATE` pour l'hôte entier. On ne choisit **jamais** « la première bonne IP ».
* **Fail closed** : erreur DNS, réponse vide, réponse non-tableau, adresse non analysable, délai (5 s) ⇒ `BLOCKED_DNS_FAILURE` / `BLOCKED_DNS_PRIVATE`.
* Les **littéraux IP** ne déclenchent aucune requête DNS (testé : 0 appel au résolveur).
* Le résolveur est injectable **uniquement** par la fabrique de test (`createEgressClient`) ; un test statique interdit au code de production d'utiliser `createEgressClient`, `addressPolicy` ou `_config`.

## 12. DNS rebinding / TOCTOU protection

**Mécanisme** (`safeFetch`, un saut) : résoudre → valider toutes les adresses → ouvrir `http(s).request` avec `host` = nom d'hôte (donc `Host`, **SNI** et vérification de certificat sur le nom) et un `lookup` **épinglé** qui ne répond *que* par les adresses validées, quel que soit le nom demandé (`family` respectée, `all:true` pour Happy-Eyeballs). Le runtime ne refait donc **aucune** résolution : une seconde réponse DNS (`127.0.0.1`) est sans effet. Aucun pinning TLS bricolé : le certificat est vérifié contre le nom d'hôte.

**Preuves** `[MESURÉ]` :

| Test | Résultat |
|---|---|
| Résolveur appelé **1 fois** par saut ; la 2ᵉ réponse (`10.9.9.9`) n'est jamais utilisée ; la connexion arrive sur l'adresse validée | PASS |
| `lookup` fourni à la socket : mêmes adresses validées pour `all:true`, `family:4`, `family:6`, et pour un **autre nom** demandé (`127.0.0.1.attacker.example`) | PASS |
| Scénario de la mission : 1ʳᵉ résolution `attacker.example → IP publique`, suivante `→ 127.0.0.1` : la socket reçoit l'IP publique, **la cible loopback reçoit 0 connexion** ; une 1ʳᵉ résolution déjà loopback est refusée | PASS |
| TLS : le SNI vu par le serveur = le nom d'hôte ; un certificat valable pour un autre nom est **rejeté** (`ERR_TLS_CERT_ALTNAME_INVALID`) bien que l'IP soit joignable ; sans CA de test, l'auto-signé est refusé (le magasin de confiance par défaut n'est pas modifié) | PASS |
| **Chromium** : le proxy résout, valide, épingle ; Chromium n'utilise pas son DNS pour le trafic proxifié | PASS (harnais réel) |

**Limites de ce mécanisme** : voir §21 — `yt-dlp` (processus externe, résolution propre) = PARTIAL ; premier saut des fournisseurs à hôte constant (`trustedHosts`) par le `fetch` du runtime, non épinglé.

## 13. Redirect policy

* `safeFetch` **ne laisse jamais le runtime suivre une redirection** (`http.request` n'en suit pas ; chemin `fetch` : `redirect:'manual'`).
* Statuts suivis : 301, 302, 303, 307, 308 **avec** `Location`. `Location` relative résolue contre l'URL précédente (`new URL(location, previous)`), puis **tout le pipeline** (§8 → §11) est rejoué sur la cible.
* **MAX_REDIRECTS = 5** par défaut (`maxRedirects` par appel ; `0` = toute redirection refusée). Le saut n°`max`+1 ⇒ `BLOCKED_TOO_MANY_REDIRECTS`. Les URL déjà visitées (fragment ignoré) ⇒ `BLOCKED_REDIRECT_LOOP` (détecté dès le 2ᵉ passage, avant la limite).
* Refusés : cible loopback / privée / link-local / metadata / schéma interdit / userinfo / port / nom local / `Location` malformée (`BLOCKED_REDIRECT`) / **downgrade https → http** (`BLOCKED_REDIRECT_DOWNGRADE`, http → https accepté).
* `Authorization`, `Cookie`, `Proxy-Authorization` sont **retirés** quand l'origine change (conservés pour une redirection de même origine).
* Un 3xx **sans** `Location` est rendu tel quel. La méthode reste GET/HEAD (aucun corps ; POST/PUT/… ⇒ `BLOCKED_METHOD`).

## 14. Port policy

**Ports standards uniquement : 80 et 443** (port effectif, après application du défaut du schéma). C'est un **changement de comportement** assumé : l'ancien code acceptait n'importe quel port. Justification : un port arbitraire est le levier classique d'un pivot SSRF (Redis `6379`, bases de données, panneaux d'admin `8080/3000/11434` joignables sur une IP publique). Aucun usage réel cassé : les services locaux (Ollama, kiwix-serve, ComfyUI, PAIR…) ne passent pas par ce garde ; Sherlock et Cyber Audit imposaient déjà `80/443` (défaut). Un appelant légitime futur doit déclarer un client dédié (`createEgressClient` est réservé aux tests ; une dérogation de port exige une décision explicite + mise à jour du test statique).

## 15. Response limits

| Limite | Valeur | Application |
|---|---|---|
| Délai d'en-têtes (par saut) | 15 s (`timeoutMs`) | `EGRESS_TIMEOUT` (nom `TimeoutError`) |
| Inactivité socket | 30 s (`idleTimeoutMs`) | coupe le corps en cours de lecture |
| Délai total | optionnel (`totalTimeoutMs`) ; absent pour les gros téléchargements | idem |
| Taille de corps **décodée** | 5 MiB par défaut (`maxBytes`) ; capture 5 MiB, deep-capture 8 MiB, image 5 MiB+1, oEmbed 256 KiB, catalogue 5 MiB, ZIM 512 GiB, ComfyUI 20 GiB | pré-contrôle `Content-Length` (refus avant lecture) + plafond en flux sur les octets **après** décompression ⇒ `BLOCKED_RESPONSE_TOO_LARGE` |
| Décompression | `gzip`, `deflate`, `br` décodés en flux sous le plafond (bombe de décompression : 64 MiB décodés depuis ~64 KiB bloqués) ; autre encodage (`zstd`…) refusé | `BLOCKED_ENCODING` |
| Annulation | `AbortSignal` honoré **pendant** les en-têtes et **pendant** le corps | `AbortError` |
| MIME | **pas imposé par le garde** (dépend de l'appelant : `image.js` valide déjà la liste blanche d'images) | — |
| Proxy navigateur | corps ≤ 256 MiB par réponse, inactivité 120 s | coupe la connexion |

## 16. Implementation

**Module** `cortex-server/src/lib/web-egress-guard.js` (aucune dépendance nouvelle ; `node:dns/http/https/net/zlib/stream/crypto` uniquement).

| API | Rôle |
|---|---|
| `validateOutboundUrl(raw, {allowHttp})` | statique : parse → schéma → userinfo → hôte → port (pas de réseau) |
| `resolveOutboundTarget(validated)` | DNS : valide **toutes** les adresses |
| `safeFetch(url, opts)` | seul point d'entrée PUBLIC_EGRESS : validation + DNS + connexion épinglée + redirections revalidées + limites ; renvoie une `Response` standard (`url`, `redirected` renseignés) |
| `safeFetch(..., { trustedHosts })` | FIXED_EXTERNAL_PROVIDER : 1ᵉʳ saut par le `fetch` du runtime (`redirect:'manual'`, objet de réponse rendu **inchangé**, ce qui préserve les tests existants qui simulent `fetch`) |
| `assertPublicDestination(url)` | validation statique + DNS sans connexion (processus externes) |
| `classifyAddress`, `isPublicAddress`, `parseIPv4/6`, `pinnedLookup` | classification et épinglage |
| `startBrowserEgressProxy`, `getSharedBrowserEgressProxy` | proxy sortant loopback pour Chromium : HTTP absolu-URI + `CONNECT`, identifiants aléatoires, `upgrade` (WebSocket) refusé, redirections **non suivies** (le navigateur rejoue chaque saut à travers le proxy) |
| `installBrowserEgressGuard(ctx, {resolve})` | filtre précoce Playwright (schémas/ports/littéraux/noms) — **pas une frontière réseau** |
| `setEgressLogger`, `reportEgressBlock` | événements `EGRESS_BLOCKED` : `reason`, `category`, `host`, `hop`, `purpose` — **jamais** userinfo, chemin, requête, en-têtes |
| `createEgressClient(config)` | **fabrique de test** (résolveur, transport, politique d'adresse, TLS injectables) ; interdite au code de production par test statique |

`assertSafeUrl` (`url-security.js`) devient un **enrobage synchrone** du garde statique (même signature, mêmes messages utilisateur) : ses ~36 appelants sont durcis sans modification.

**Lancement Chromium** (`deep-capture.js`, `pdf.js`) : `chromium.launch({ proxy: { server, username, password, bypass: '<-loopback>' }, args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] })`. `<-loopback>` supprime l'exemption implicite des noms/adresses loopback, de sorte que `localhost` et `127.0.0.1` passent eux aussi par le proxy (qui les refuse).

---

## 17. Migrated fetch callsites

### 17.1 Les 4 appels signalés par l'audit

| # | Callsite (ligne d'origine) | BEFORE | AFTER |
|---|---|---|---|
| 1 | `lib/image.js` `downloadImageFromUrl` (64) | `assertSafeUrl` (préfixes de chaîne, contournable par `[::ffff:…]`) puis `fetch(rawUrl, { redirect: 'follow' })` : redirections **aveugles**, DNS du runtime, corps lu **entièrement** avant le contrôle de taille 5 Mo | `assertSafeUrl` (garde central) puis `safeFetch(rawUrl, { maxBytes: MAX_SIZE + 1 })` : DNS validé, connexion épinglée, **chaque** saut revalidé, plafond **en flux**. Échec : `EgressDeniedError` (`BLOCKED_*`), jamais de repli |
| 2 | `lib/comfyui-install-manager.js` `downloadWithProgress` (258) | `fetch(url, { redirect: 'follow' })`, URL = constante `github.com/comfyanonymous/ComfyUI/releases/…` | `safeFetch(url, { trustedHosts: ['github.com'], maxBytes: 20 GiB })` : 1ᵉʳ saut hôte constant ; le saut de redirection vers le CDN est **entièrement validé et épinglé** |
| 3 | `lib/comfyui-model-manager.js` `runModelDownload` (80) | `fetch(entry.source, { redirect: 'follow' })`, `source` = entrée de catalogue constante (`huggingface.co`) | `safeFetch(entry.source, { trustedHosts: ['huggingface.co'], maxBytes: 20 GiB })` |
| 4 | `lib/free-ai-catalog.js` `fetchCatalog` (110-112) | `fetch(CATALOG_URL, { redirect: 'follow' })` (`raw.githubusercontent.com`) | `safeFetch(CATALOG_URL, { trustedHosts: ['raw.githubusercontent.com'], maxBytes: 5 MiB })` |

### 17.2 Autres appels présentant la même faiblesse (trouvés par la cartographie)

| # | Callsite | BEFORE | AFTER |
|---|---|---|---|
| 5 | `lib/capture.js` `fetchText` (134) — 7 appelants | `fetch(url)` **redirections par défaut**, DNS runtime, `response.text()` illimité | `safeFetch(url, { maxBytes: 5 MiB })` |
| 6 | `lib/deep-capture.js` `httpFetch` (455) | idem | `safeFetch(url, { maxBytes: 8 MiB })` ; `finalUrl` conservé (`res.url`) |
| 7 | `lib/deep-capture.js` oEmbed (736) | `fetch` par défaut (`www.youtube.com`, URL en paramètre encodé) | `safeFetch(…, { maxBytes: 256 KiB })` |
| 8 | `server.js` oEmbed (1322) | idem | `safeFetch(…, { trustedHosts: ['www.youtube.com'] })` |
| 9 | `lib/deep-capture.js` `extractWithPlaywright` (Chromium) | `chromium.launch({ headless: true })` ; `page.goto` suit les redirections avec le DNS de Chromium | Chromium lancé **à travers le proxy de sortie** + filtre statique `context.route` |
| 10 | `lib/pdf.js` `generatePdf` (Chromium, HTML issu de documents) | Chromium sans proxy : une note hostile (`<img src=http://127.0.0.2:…>`) faisait atteindre la cible | proxy de sortie partagé (test : 0 connexion, contrôle positif OK, PDF toujours produit) |
| 11-12 | `routes/kiwix.js` `resolveMetalinkUrl` (34) et téléchargement ZIM (348) | `fetch` par défaut ; l'URL du **miroir vient d'un XML distant** ; vérification statique seulement | `safeFetch` (plafonds 1 MiB / 512 GiB) |
| 13 | `lib/kiwix-catalog.js` (19) | `fetch` par défaut | `safeFetch({ trustedHosts: ['library.kiwix.org'] })` |
| 14 | `lib/web-search.js` (20) | `fetch` par défaut | `safeFetch({ trustedHosts: ['html.duckduckgo.com'] })` |
| 15 | `lib/connectors/google-drive-rate-limit.js` (13) | `fetch` par défaut | `safeFetch({ trustedHosts: [hôte de l'URL constante Google] })` |
| 16 | `lib/connectors/onedrive-connector.js` `downloadFileContent` | `fetch(downloadUrl)` ; URL **émise par Graph**, redirections aveugles | `fetchImpl: safeFetch({ trustedHosts: [hôte émis] })` (https, jamais IP littérale ; sauts de redirection validés et épinglés) |

Décompte : **4 signalés + 12 supplémentaires = 16 points d'appel migrés** (dont 2 chemins Chromium : deep-capture et export PDF). `server.js` reçoit aussi une ligne `setEgressLogger(logger)` pour le journal structuré.
Appels **non migrés par conception** (justifiés, figés par le test statique) : constantes de fournisseurs IA et jetons OAuth (POST/JSON, aucune composante d'URL variable), services locaux, protocoles certifiés, passerelles Sherlock/Cyber (voir §5, §21).

---

## 18. Tests

| Fichier | Contenu | Résultat |
|---|---|---|
| `cortex-server/test-web-egress-guard.mjs` | **54** tests : analyse IPv4/IPv6 (aller-retour sur 500 adresses aléatoires), classification (loopback, **classe IPv4-embarquée**, bornes RFC1918/CGNAT avant/début/fin/après, metadata, IPv6 spécial + liste blanche, inconnu ⇒ fermé), parité avec Sherlock/Cyber, validation statique (URL publiques, formes loopback, mapped, privé/link-local/metadata/multicast/réservé, noms locaux, userinfo, schémas, ports, malformé, `assertSafeUrl` compatible), DNS (public, privé, **mixte dans les deux ordres**, échec/vide/timeout/exception, littéraux sans DNS), **redirections sur serveurs loopback réels** (public→public relatif/absolu/chaîné ; →loopback/mapped/privé/IPv6 ULA/link-local/metadata/`file:`/`ftp:`/`data:`/`javascript:`/userinfo/DNS mixte/port/nom local/`Location` malformée/hôte vide ; public→public→privé ; boucles ; chaîne infinie ; `maxRedirects=0` ; 3xx sans Location ; Authorization/Cookie retirés en cross-origin), limites (Content-Length, flux, exactement `maxBytes`, **bombe de décompression**, gzip/deflate/br, zstd refusé, timeouts en-têtes/inactivité/total, `AbortSignal`), **rebinding/TOCTOU** (3 tests), **TLS** (SNI = nom d'hôte, mauvais nom rejeté, auto-signé refusé, downgrade refusé), mode `trustedHosts` (3), journalisation sans secret (2), filtre navigateur (2), valeurs par défaut | **54/54 PASS** |
| `cortex-server/test-web-egress-static-audit.mjs` | tout primitive réseau de `src/` classée avec son **nombre exact** d'occurrences ; fichiers migrés importent le garde et n'ont **aucun** `fetch`/`http.request` brut ; `redirect:'follow'` interdit ; chaque `chromium.launch` passe par le proxy partagé ; couches de test (`createEgressClient`, `addressPolicy`, `_config`) interdites au code de production ; aucun module gelé n'importe le garde ; OneDrive passe par le garde | **7/7 PASS** |
| `cortex-server/test-web-egress-harness.mjs` | harnais réel (§19) | **11/11 PASS** |
| `cortex-server/web-egress-boot-proof.mjs` | démarrage réel isolé (§20) | **PASS** |

**Garde-fou « zéro réseau »** : la suite unitaire installe un espion sur `dns.promises.lookup` et `net.Socket.connect` ; elle échoue si un nom réel est résolu ou si une connexion non épinglée sort de la boucle locale (preuve : 0). Aucun paquet n'est envoyé vers `10.x`, `192.168.x`, `169.254.169.254` ni aucune machine du LAN.

Catégories demandées : *unit* (analyse, classification, URL, DNS) ; *security* (userinfo, schémas, ports, metadata, journaux, test statique) ; *redirect* (matrice complète, boucles, limite, en-têtes) ; *DNS* (5 tests) ; *rebinding* (3) ; *regression* (§20) ; *browser* (harnais Chromium réel, §19, + `scripts/test-article-capture-pipeline.mjs` 8/8).

---

## 19. Real local harness

Cibles : un serveur HTTP **compteur** sur `127.0.0.2` (le service interne visé), une cible HTTPS sur `127.0.0.2` (certificat `openssl` éphémère), une origine « publique » sur `127.0.0.1` et son pendant HTTPS. Tout est lié à la **loopback** (jamais `0.0.0.0`). Chromium réel (Playwright).

| Scénario | Résultat |
|---|---|
| **Contrôle positif** : Chromium **sans** proxy atteint la cible, en direct **et** par redirection (`/secret` reçu) ; idem HTTPS | cible joignable, compteurs réels |
| Page publique via le proxy | 200, contenu servi ; proxy sans identifiants ⇒ 407 ; upgrade WebSocket refusé |
| **HTTPS légitime via le proxy** (CONNECT + défi d'auth + TLS bout en bout) | 200 |
| **Redirect public → interne** (1 et 2 sauts), **avec et sans** filtre `route()` | refus (403 + `X-Egress-Blocked`), `connections_received = 0` |
| HTTPS direct et par redirection vers la cible interne | refus avant connexion |
| `fetch()` de script de page, `<img>`, `<iframe>` vers la cible | bloqués, 0 connexion |
| `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `localhost`, `127.0.0.2` | refus ; l'origine **n'est pas contactée** par les formes mappées/`localhost` |
| **Câblage production** : `extractWithPlaywright` (garde strict par défaut) vers loopback, mappé loopback | `null`, 0 connexion, événement `EGRESS_BLOCKED` (`purpose: browser`) sans chemin dans le log |
| `downloadImageFromUrl`, `safeFetch`, `buildCaptureResult` vers loopback / mappé | `BLOCKED_*`, 0 connexion |
| **Export PDF** d'un HTML hostile (`<img>`, `<iframe>`, `<link>` vers la cible) | PDF produit, 0 connexion ; contrôle positif : le même HTML rendu sans proxy **atteint** la cible |
| Résumé | `forbidden_connections_received_by_target = 0` (cibles HTTP et HTTPS) |

**Deux défauts trouvés par ce harnais et corrigés avant livraison** (preuve que les tests mordent) :
1. Un filtre `context.route()` seul ne voit pas les sauts de redirection de Chromium (la cible a reçu `/secret`) ⇒ remplacé par le proxy de sortie (frontière réseau) ; le filtre n'est conservé que comme garde statique précoce.
2. Le proxy ne renvoyait pas `Proxy-Authenticate` sur la réponse 407 d'un `CONNECT` ; Chromium refusait **toute** navigation HTTPS (`ERR_PROXY_AUTH_UNSUPPORTED`). Détecté par un **smoke réel** (voir ci-dessous) car les tests de blocage HTTPS réussissaient « trivialement » ; correction + test positif HTTPS ajouté.

**Smoke réel unique** (hors suite, une requête vers `example.com`, domaine IANA réservé aux exemples) : `safeFetch` HTTPS et HTTP (DNS réel, TLS réel avec SNI + vérification de certificat, décodage) → 200 « Example Domain » ; Chromium via proxy (CONNECT + TLS réel) → 200. Aucune donnée Docteur envoyée.

---

## 20. Regression results

Méthode : le manifeste déterministe de Docteur (`node test-manifest.mjs --run`, **179 fichiers de test sûrs (sur 184 `test-*.mjs`)**, `--experimental-test-module-mocks`) exécuté **seul** (un balayage lancé par erreur en double a été écarté : deux balayages concurrents se disputent ports et dossiers `data-test-*` et produisent de faux échecs). Aucun test existant n'a été modifié.

| Exécution (code final) | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| Balayage complet, concurrence par défaut (nouvelles suites incluses) | 3 046 | 3 030 | **9** (tous `test-rassilon-battery-idle.mjs`) | 0 | 7 |
| Même balayage **sans** les 3 nouvelles suites | 2 974 | 2 958 | **9** (idem) | 0 | 7 |
| Balayage complet, `--test-concurrency=3` | 3 046 | 3 034 | **0** | **5** (tous `test-youtube-smart-discovery.mjs`) | 7 |

**Aucun échec ne survit à toutes les configurations ; aucun n'a de lien avec le garde.** Détail :

* **9 × `test-rassilon-battery-idle.mjs`** (RASSILON, FROZEN — `AUTO_PAUSED` au lieu de `IDLE`) : le garde de ressources de RASSILON mesure le **CPU système** (`os.cpus()`, delta de deux instantanés) et met le worker en pause quand la machine est saturée ; le balayage complet en parallèle sature cette machine. Preuves : **17/17 en isolation** ; **0 échec à concurrence 3** ; mêmes 9 échecs **sans mes suites** ; la fermeture d'imports statiques du test (19 fichiers) ne contient **aucun** module touché par cette mission. Classé `ENVIRONMENTAL / load-sensitive` (même famille que les sondes PowerShell instables déjà documentées par les certifications précédentes).
* **5 × cancelled dans `test-youtube-smart-discovery.mjs`** (fichier **non commité**, mission YouTube Smart Discovery V2) : course de test préexistante — le test `killProcessTree … (fake bootloader + worker)` attend `parent.once('close', …)` **après** `await killProcessTree(parent)` ; si `close` est émis pendant ce `await`, la promesse ne se résout jamais, la boucle d'événements se vide et le runner annule le test et les suivants (`Promise resolution is still pending but the event loop has already resolved`). 29/29 en isolation (×2), 141/141 sur le sous-ensemble final de la liste (×3), 0 occurrence dans 3 balayages à concurrence par défaut. `process-tree.js` et cette zone ne sont pas touchés.
* **7 skipped historiques** : Ollama réel non disponible (3 × calibration/qualité d'embedding réels + 1 smoke d'embedding réel : `NOT_RUN`), tests réservés à un OS non-Windows (2), saisie Windows réelle OMEGA (1).
* **NEW test failures : 0.**

Suites qui exercent les modules migrés — toutes **PASS dans le balayage à concurrence 3 (0 échec)** et dans les balayages à concurrence par défaut : `test-free-ai-catalog`, `test-free-ai-routes`, `test-comfyui-install-manager`, `test-image-generation`, `test-phase4-free-ai-images`, `test-batch-c-onedrive-size-limit`, `test-batch-d-connectors`, `test-phase2-connectors` (relancées aussi individuellement après la migration des connecteurs : 111/111 avec la suite du garde), `test-kiwix-*`, `test-investment-route`, `test-sales-route`, `test-youtube-smart-discovery`, `test-phase1-egress-certification` (verrou privacy), `test-strict-local-centralized`, ainsi que les suites OMEGA / RASSILON / Device Fabric / MAÎTRE / Observateur / Notebook.

**Frontend / navigateur** : `npx tsc --noEmit` **PASS** (exit 0) ; `npm run build` **PASS** (exit 0, PWA 39 entrées / 2 294 KiB, avertissement de taille de chunk préexistant) ; `scripts/test-article-capture-pipeline.mjs` **8/8 PASS** (inclut le repli Playwright, maintenant derrière le proxy) ; `scripts/test-article-capture-browser.mjs` (fichier **non commité**, UI avec backend **entièrement simulé**, fermeture d'imports de 2 fichiers sans lien avec le serveur) **échoue sur une assertion de timing d'interface** (`Analyse locale|Enregistrement` attendu, `Indexation…` affiché) — sans rapport avec cette mission, non investigué.

**Démarrage réel isolé** : `node web-egress-boot-proof.mjs` — serveur réel sur SQLite/LanceDB/log jetables, boucle locale seulement : démarrage OK, `GET /api/health` 200, **9 charges hostiles refusées en HTTP 400** par la vraie route (dont le payload d'origine `http://[::ffff:127.0.0.1]/`), 8 raisons `BLOCKED_*` écrites dans le journal, **aucun** secret/chemin/requête/userinfo dans le journal, arrêt propre. Base réelle jamais utilisée.

**Secrets / vie privée** : le journal ne contient que `reason`, `category`, nom d'hôte, `hop`, `purpose` (test dédié + preuve de boot) ; `Authorization`/`Cookie` retirés à la redirection cross-origin ; aucune URL complète persistée ; **aucune télémétrie**, aucun service tiers contacté pour « vérifier » une URL, aucune nouvelle dépendance (`package.json` et lockfiles inchangés).

---

## 21. Remaining limitations

| # | Limite | Gravité | Détail / recommandation |
|---|---|---|---|
| L1 | **Processus externes (`yt-dlp`) : PARTIAL** | moyenne | `ytdlp.js` (×3), `video-audio-download.js`, `whisper.js` (`getVideoDuration`), `youtube-discovery.js` lancent `yt-dlp` avec l'URL de l'utilisateur. Ils sont protégés **statiquement** (`assertSafeUrl` durci : http/https seulement, mapped/IPv6/userinfo/port/noms locaux refusés — l'URL ne peut donc pas commencer par `-`), mais `yt-dlp` **résout le DNS et suit les redirections lui-même** (extracteur générique) : ni épinglage, ni revalidation par saut. Ajouter une pré-résolution DNS à ces six points serait une protection partielle trompeuse (et ferait résoudre le DNS réel dans les tests existants qui injectent un faux `spawn`). Pistes : liste blanche de domaines média (Root Policy, mission suivante) ou exécution de `yt-dlp` à travers le même proxy de sortie (`--proxy`), à décider. |
| L2 | Premier saut des fournisseurs à hôte constant | faible | Avec `trustedHosts`, le 1ᵉʳ saut utilise le `fetch` du runtime (DNS du runtime, non épinglé). Hôtes **constants** (github.com, huggingface.co, raw.githubusercontent.com, library.kiwix.org, html.duckduckgo.com, www.youtube.com, googleapis.com) ; hôte **issu de Microsoft Graph** pour OneDrive (https, jamais IP, hors suffixes locaux). Un attaquant ne contrôle pas ces noms. Tous les sauts de redirection sont validés et épinglés. Choix imposé aussi par les suites existantes qui simulent `fetch` (non modifiées). |
| L3 | Appels à base constante non migrés | faible | Fournisseurs IA (`anthropic`, `gemini`, `groq`, `openai`, `openrouter`, `whisper-groq`), jetons OAuth, API Google/Graph à base constante : POST/JSON, aucune composante d'URL variable, aucun suivi de redirection utile. Figés par le test statique. |
| L4 | Services locaux **configurables** non validés | faible | Les points d'extrémité Ollama / ComfyUI / PAIR / FreeLLMAPI sont saisis par l'utilisateur dans les réglages (classe C) ; ils ne sont pas routés par le garde. La modification de ces réglages par une page web est déjà refusée par le garde entrant NB-7 (459 routes non gelées prouvées). Observation annexe : `providers/pair.js` importe `node-fetch`, absent des `dependencies`. |
| L5 | Chemin navigateur | faible | WebSocket via le proxy : refusé (501). QUIC/HTTP3 non utilisé avec un proxy HTTP. UDP WebRTC : `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (activé, **non testé** par un scénario WebRTC). Le filtre `route()` n'est qu'un garde statique précoce ; la frontière est le proxy. `pdf.js` lance Chromium avec `--no-sandbox` (préexistant, non modifié) : à traiter dans une mission de durcissement dédiée. |
| L6 | Ports | politique | 80/443 uniquement (changement de comportement assumé, §14). Une URL d'article en `:8443` est désormais refusée avec « port non autorisé ». |
| L7 | DNS | faible | Résolveur système (`getaddrinfo`) : un DNS interne légitime à « horizon partagé » renvoyant une adresse privée pour un nom public sera refusé (voulu). Pas de DoH. |
| L8 | Encodages | faible | `gzip`/`deflate`/`br` décodés ; `zstd` et autres refusés (`BLOCKED_ENCODING`). |
| L9 | MIME | n/a | Le garde ne valide pas le type MIME (il dépend de l'appelant ; `image.js` valide déjà sa liste blanche). |
| L10 | Modules gelés | — | Aucune modification (test statique). Sherlock et Cyber Audit gardent leur implémentation d'origine (parité vérifiée) : **deux classificateurs dupliqués subsistent** — consolidation à planifier par une mission d'unfreeze dédiée. L'exposition **entrante** des 168 routes gelées (garde NB-7) reste le prochain chantier signalé par NB-7. |
| L11 | Tests suites existantes | — | 9 échecs de `test-rassilon-battery-idle.mjs` observés sous charge dans un balayage, **17/17 en isolation** (sondes PowerShell, module RASSILON, sans lien avec le garde) — voir §20. |
| L12 | `yt-dlp`/`ffmpeg` non épinglés (PATH) | hors sujet | Constat de l'audit maître, non traité ici. |

## 22. Files modified

`git status` (lecture seule). **Nouveaux fichiers** :

| Fichier | Rôle |
|---|---|
| `cortex-server/src/lib/web-egress-guard.js` | le garde central |
| `cortex-server/test-web-egress-guard.mjs` | 54 tests unitaires / sécurité / redirections / DNS / rebinding / TLS |
| `cortex-server/test-web-egress-static-audit.mjs` | audit statique de la surface sortante |
| `cortex-server/test-web-egress-harness.mjs` | harnais réel (serveurs compteurs + Chromium) |
| `cortex-server/web-egress-boot-proof.mjs` | preuve de démarrage réel isolé |
| `reports/WEB_EGRESS_GUARD_V1_2026-10.md` | ce rapport |

**Fichiers existants modifiés par cette mission** (modifications minimales : import + remplacement de l'appel + commentaire) :

`cortex-server/src/lib/url-security.js` (réécrit en enrobage) · `lib/capture.js` · `lib/deep-capture.js`\* · `lib/image.js` · `lib/pdf.js` · `lib/comfyui-install-manager.js` · `lib/comfyui-model-manager.js` · `lib/free-ai-catalog.js` · `lib/kiwix-catalog.js` · `lib/web-search.js` · `lib/connectors/google-drive-rate-limit.js` · `lib/connectors/onedrive-connector.js` · `routes/kiwix.js` · `server.js`\*

\* **Ces deux fichiers portaient déjà des modifications non commitées d'autres missions** (YouTube Smart Discovery V2 / article capture / NB-7…). Mes ajouts y sont isolés : `deep-capture.js` (import, `getBrowser`, `closeDeepCaptureBrowserForTests`, `httpFetch`, oEmbed, `installBrowserEgressGuard`) ; `server.js` (import + `setEgressLogger(logger)` + l'appel oEmbed). Les autres modifications de ces fichiers n'ont **pas** été touchées.

Aucun fichier de `device-fabric*`, `omega*`, `rassilon*`, `maitre*`, `monitor*`, `notebook*`, aucun test existant, aucun `package.json`/lockfile, aucun dépôt externe imbriqué.

---

## 23. Final checkpoint

```
WEB EGRESS GUARD V1 — FINAL CHECKPOINT

Original IPv4-mapped IPv6 bypass reproduced before fix: YES — assertSafeUrl('http://[::ffff:127.0.0.1]/') returned without error
  (39-probe baseline, §3: 18 forbidden forms passed (20 ALLOWED incl. 2 legitimate public URLs); https://fdic.gov/ was wrongly blocked)
Original payload:
http://[::ffff:127.0.0.1]/

Blocked after fix: YES — BLOCKED_LOOPBACK (unit tests; real server route => HTTP 400; real harness => 0 connections)

Loopback IPv4 blocked: YES (127/8; decimal, hex, octal and short forms normalised by the parser)
Loopback IPv6 blocked: YES (::1)
IPv4-mapped loopback blocked: YES (::ffff:127.0.0.1, ::ffff:7f00:1, any case/expansion)
Private IPv4 blocked: YES (10/8, 172.16/12, 192.168/16, 100.64/10 — before/start/end/after boundaries tested)
Private IPv6 blocked: YES (fc00::/7, fec0::/10, mapped/NAT64/6to4 forms of private IPv4)
Link-local blocked: YES (169.254/16, fe80::/10, mapped form)
Metadata endpoint blocked: YES (169.254.169.254, 169.254.170.2, 100.100.100.200, 192.0.0.192, 168.63.129.16, fd00:ec2::254, mapped form)
Unspecified addresses blocked: YES (0.0.0.0, ::, ::ffff:0.0.0.0)
Relevant reserved ranges blocked: YES (multicast 224/4 + ff00::/8, 240/4, 0/8, 192.0.0/24, TEST-NET-1/2/3, 192.88.99/24, 198.18/15,
  IPv6 outside 2000::/3, 2001::/23, 2001:db8::/32, 3fff::/20, ::ffff:/96 public forms, ::/96, 64:ff9b::/96, 64:ff9b:1::/48, 2002::/16)

URL parser canonicalization tested: YES (WHATWG parser only; decimal/hex/octal/short IPv4, case, trailing dot, brackets, backslash)
Userinfo confusion tested: YES (BLOCKED_USERINFO; '#@', '?@', '/@' forms keep the true public host)
Forbidden schemes blocked: YES (explicit allow-list http/https; file ftp data javascript gopher ws wss blob mailto ldap dict tftp about chrome view-source)

DNS resolution implemented: YES
All resolved addresses validated: YES (never "first good IP")
Mixed public/private DNS result blocked: YES (both orders)
DNS failure fail-closed: YES (error, empty, malformed, timeout, exception)

DNS rebinding/TOCTOU protection: YES for safeFetch and for Chromium (egress proxy pins the validated address);
  PARTIAL for (a) the yt-dlp external process (resolves/redirects by itself) and (b) the first hop of FIXED_EXTERNAL_PROVIDER
  callsites using trustedHosts (constant hosts, runtime fetch) — documented limits L1/L2
Connection uses validated address: YES (resolver called once per hop; socket lookup returns only validated addresses; proven by tests)
TLS/SNI preserved correctly: YES (SNI = hostname, wrong-name certificate rejected, self-signed refused; real example.com smoke PASS)

Automatic unsafe redirects remaining: 1 class — yt-dlp (external process, PARTIAL, §21 L1); 0 in Node fetch paths and 0 in Chromium paths
Redirects revalidated individually: YES (parse → resolve → validate → pinned connect per hop)
Redirect to loopback blocked: YES
Redirect to private IP blocked: YES
Redirect to link-local blocked: YES
Redirect to forbidden scheme blocked: YES
Redirect loop bounded: YES (loop detection + MAX_REDIRECTS = 5)

Original vulnerable fetch callsites identified: 4 (image.js:64, comfyui-install-manager.js:258, comfyui-model-manager.js:80, free-ai-catalog.js:112)
Original vulnerable fetch callsites migrated: 4
Additional vulnerable callsites found: 12 (capture.js, deep-capture.js ×3 incl. Chromium navigation, routes/kiwix.js ×2, kiwix-catalog.js,
  web-search.js, server.js oEmbed, Google Drive, OneDrive issued-URL download, pdf.js Chromium) + yt-dlp processes (not migrable, PARTIAL)
Additional callsites migrated: 12

Public egress separated from trusted local services: YES (classes A/B/C/D/E; static audit pins every outbound primitive)
OMEGA networking modified: NO
RASSILON networking modified: NO
Device Fabric networking modified: NO

Real local loopback harness: PASS 11/11 (Chromium + counting HTTP/HTTPS targets + PDF export + production wiring)
Forbidden connections received by target: 0 (positive controls proved the target is reachable without the guard)

Unit tests: 54/54 PASS (test-web-egress-guard.mjs)
Security tests: PASS (userinfo, schemes, ports, metadata, logging, static audit 7/7, boot proof)
Redirect tests: PASS
DNS tests: PASS
Rebinding tests: PASS
Regression tests: full backend manifest — see §20 (3 046 tests; 0 NEW failures)
Browser tests: harness 11/11 + article-capture pipeline 8/8 PASS; 1 untracked UI test (mocked backend) fails on an unrelated timing assertion
Typecheck: PASS
Production build: PASS
Boot smoke: PASS (isolated real server, 9 hostile payloads => HTTP 400, structured logs, no leak, clean shutdown)

NEW test failures: 0
Historical failures: none deterministic. Load-sensitive in parallel sweeps only: 9 × test-rassilon-battery-idle (17/17 alone, 0 at concurrency 3);
  race in uncommitted test-youtube-smart-discovery (5 cancelled in one configuration, 29/29 alone)
Historical skips: 7 (real Ollama NOT_RUN ×4, non-Windows ×2, real Windows input ×1)

Secrets exposed: 0
Telemetry added: 0
New cloud dependency: 0
New runtime dependency: 0

Frozen modules functionally modified: 0

Files modified:
  new      cortex-server/src/lib/web-egress-guard.js
           cortex-server/test-web-egress-guard.mjs
           cortex-server/test-web-egress-static-audit.mjs
           cortex-server/test-web-egress-harness.mjs
           cortex-server/web-egress-boot-proof.mjs
           reports/WEB_EGRESS_GUARD_V1_2026-10.md
  modified cortex-server/src/lib/url-security.js, capture.js, deep-capture.js*, image.js, pdf.js, comfyui-install-manager.js,
           comfyui-model-manager.js, free-ai-catalog.js, kiwix-catalog.js, web-search.js,
           connectors/google-drive-rate-limit.js, connectors/onedrive-connector.js, routes/kiwix.js, server.js*
  (* already carried uncommitted changes from other missions)

Report:
reports/WEB_EGRESS_GUARD_V1_2026-10.md

FINAL STATUS:
PASS_WITH_LIMITATIONS
```

**Pourquoi `PASS_WITH_LIMITATIONS` et pas `PASS`** : le contournement d'origine est corrigé comme **classe**, DNS et redirections sont revalidés, le rebinding est traité (preuves), les 4 appels signalés et 12 autres sont migrés, aucun module gelé n'est touché, et `typecheck`/`build`/`boot` passent. Mais l'énoncé exige qu'**aucun callsite vulnérable connu ne conserve un suivi aveugle** et qu'une protection DNS rebinding **partielle** ne soit pas certifiée « PASS complet » : les processus **`yt-dlp`** (URL utilisateur, résolution et redirections faites par le binaire lui-même) restent protégés **statiquement seulement** (L1), et le premier saut des fournisseurs à hôte constant n'est pas épinglé (L2, risque faible). Les prochaines étapes naturelles (hors de cette mission) : faire passer `yt-dlp` par le même proxy de sortie ou le restreindre à une liste de domaines média (Root Policy), et consolider les deux classificateurs d'adresses préexistants (Sherlock, Cyber Audit) sur le garde central via une mission d'unfreeze.

**STOP.** Rien d'autre n'a été commencé (Root Policy, Runtime Supervisor, Document Toolbox, Browser Media Bridge, QR Transfer, Investigator, Agency, Media Studio). La mission suivante attend la validation humaine de WEB EGRESS GUARD V1.
