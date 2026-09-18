# Cyber Audit Agent V1 — SENTINEL

Date : 2026-09-18

## Objectif et décision de périmètre

Agent d'audit de sécurité web **externe, autorisé et non destructif** :
observation TLS/en-têtes de sécurité/cookies/CORS/divulgation
d'information sur un périmètre explicitement déclaré et confirmé par
l'utilisateur. **Aucune exploitation, aucun brute force, aucun
contournement d'authentification, aucun scan de ports, aucun déni de
service, aucun shell/child_process, aucun outil offensif tiers
(Nmap/Nuclei/SQLMap/Metasploit/ZAP).**

Décision explicite de périmètre V1 : un moteur de scan **entièrement
déterministe, sans LLM**, avec un chokepoint réseau unique
(`cyber-gateway.js`) que tout le reste du système traverse
obligatoirement. Chaque phase (CA-1 à CA-10) a été développée et
certifiée séparément avec un checkpoint adversarial avant de passer à la
suivante — aucune phase n'a modifié les garanties de sécurité déjà
validées par une phase antérieure sans qu'un test précis ne démontre un
bug réel.

## Threat model

- **Cible** : un site web pour lequel l'utilisateur a explicitement
  confirmé être propriétaire ou disposer d'une autorisation (case à
  cocher obligatoire, `authorizationConfirmed === true` littéral, jamais
  une chaîne vérité comme `"true"`).
- **Risques traités** :
  - SSRF / DNS rebinding — toute résolution DNS est revalidée à chaque
    hop de redirection, l'adresse résolue est épinglée dans la socket
    réelle (pas de fenêtre entre la vérification et la connexion).
  - Sortie de scope — hôte/port/protocole/chemin validés avant chaque
    requête (syntaxique) ET après résolution DNS (réseau), sur la requête
    initiale ET sur chaque redirection.
  - Fuite de secrets dans les preuves/rapport — redaction obligatoire des
    en-têtes sensibles (Authorization, Cookie, Set-Cookie, JWT, clés
    API), en profondeur (CA-5 redacte à la persistance, CA-9 re-redacte
    au moment du rapport, indépendamment).
  - XSS dans le rapport — tout contenu provenant de la cible est échappé
    HTML avant insertion dans le document (une seule fonction
    d'échappement, aucune concaténation brute).
  - Prompt injection — le texte libre d'une page cible n'est jamais
    interprété comme une instruction ; une URL de crawl ne peut provenir
    que d'un vrai lien `<a href>` qui passe la politique de scope.
  - Déni de service accidentel contre la cible — requêtes bornées
    (maxRequests, maxDepth), débit borné et **réellement appliqué**
    (CA-7.1), timeout mission.
- **Hors périmètre V1** (documenté explicitement, jamais laissé
  implicite) : audit authentifié, exploitation, brute force, scan de
  ports, fuzzing, audit de code source, audit cloud/conteneur, pentest
  complet.

## Architecture

```
CyberAuditStudioModal (frontend, lazy chunk)
    ↓ fetch (cyber-audit-studio.ts)
routes/cyber-audit.js (API sémantique, loopback-only, jamais d'URL/scope arbitraire dans le body)
    ↓
cyber-orchestrator.js (CA-7 — SEUL point d'orchestration)
    ├─→ cyber-policy.js       (scope/authorization/SSRF/méthode — deny-by-default)
    ├─→ cyber-crawler.js      (CA-6 — découverte bornée, liens réels uniquement)
    │      ↓
    │   cyber-gateway.js      (CA-3 — seul module à ouvrir une socket réelle)
    │      ↓
    │   cyber-rate-limiter.js (CA-7.1 — token bucket par mission, un seul chokepoint)
    ├─→ cyber-detect-*.js     (CA-4 — 5 détecteurs purs : tls/headers/cookies/cors/info-disclosure)
    ├─→ cyber-evidence.js     (CA-5 — persistence, redaction obligatoire à l'écriture)
    ├─→ cyber-report.js       (CA-9 — génération HTML/JSON déterministe, re-redaction, échappement)
    └─→ sqlite.js              (cyber_audit_missions/scopes/requests/evidence/findings/events)
```

Aucune nouvelle dépendance npm ajoutée pour CA-8/CA-9/CA-10 (jsdom était
déjà utilisé ailleurs dans le projet pour le parsing HTML sûr ; aucune
librairie PDF/headless-browser ajoutée — PDF = NOT IMPLEMENTED par choix
explicite).

## CA-1 → CA-10 — résumé par phase

- **CA-1** : audit d'architecture read-only, aucune ligne de code écrite.
- **CA-2** : modèle de mission + politique de scope (`cyber-policy.js`),
  refus des wildcards, ports/protocoles/chemins explicites,
  `authorizationConfirmed` littéral obligatoire.
- **CA-3** : gateway HTTP/TLS sûr (`cyber-gateway.js`) — DNS résolu et
  revalidé à chaque redirection, adresse épinglée dans la socket,
  méthodes GET/HEAD/OPTIONS uniquement (POST/PUT/PATCH/DELETE/CONNECT/
  TRACE explicitement refusés, pas seulement "absents de la liste").
  Checkpoint adversarial : 39/39.
- **CA-4** : 5 détecteurs purs et déterministes (TLS, en-têtes de
  sécurité, cookies, CORS, divulgation d'information) — jamais d'accès
  réseau dans un détecteur, séparation stricte sévérité/confiance
  (`CRITICAL` structurellement impossible sans confiance `HIGH`).
  Checkpoint : 107/107.
- **CA-5** : persistence structurée (6 tables SQLite) avec redaction
  obligatoire et inconditionnelle à l'écriture des preuves (double
  redaction si l'appelant a déjà redacté — jamais l'inverse). Checkpoint :
  132/132.
- **CA-6** : crawler borné — découverte UNIQUEMENT à partir des URLs de
  départ de la mission, des liens réels trouvés dans des pages déjà
  autorisées, de robots.txt et sitemap.xml (jamais de génération de
  chemins). File d'attente bornée, déduplication, limite de variantes de
  query string par chemin, liens destructifs (logout/delete/checkout/...)
  écartés en défense en profondeur. Checkpoint : 169/169. Un bug
  pré-existant démontré par test a été corrigé à cette occasion :
  `scope.timeoutMs` était validé/persisté mais jamais lu par
  `cyber-gateway.js` (toujours le timeout global 10s, quel que soit le
  scope) — corrigé dans `safeCyberFetch` uniquement.
- **CA-7** : machine d'état de mission propre (`CREATED → READY →
  RUNNING → COMPLETED`, avec échappatoires `CANCELLED`/`FAILED`/
  `BLOCKED_BY_POLICY`), orchestrateur unique reliant crawler+détecteurs+
  persistence, API sémantique (`/api/cyber-audit/missions/...`), annulation
  idempotente avec protection de race (un scan qui se termine juste après
  un cancel ne peut jamais écraser `CANCELLED` par `COMPLETED`).
  Checkpoint : 221/221.
- **CA-7.1** : correction du gap de rate limiting. `scope.requestsPerSecond`
  était validé/borné/persisté mais **jamais réellement appliqué** au
  trafic sortant avant cette phase — c'est le seul point du système où le
  précédent checkpoint CA-7 était incomplet sans que cela ait été
  explicitement signalé comme un manque à corriger. Corrigé par un token
  bucket unique par mission (`cyber-rate-limiter.js`), branché au seul
  point où une socket réelle est ouverte (les trois fonctions de
  `cyber-gateway.js`, y compris **chaque saut de redirection** — un hop
  redirigé est une requête réseau réelle à part entière et compte comme
  telle). Aucun busy-wait, aucun timer orphelin, annulation/timeout
  pendant l'attente traités immédiatement. Checkpoint : 240/240.
- **CA-8** : Cyber Audit Studio (frontend) — wizard en 6 étapes (Mission
  → Autorisation → Scope → Mode → Limits → Review → Start), vues
  Overview/Scope/Scan/Findings/Evidence/Remediation/Report/History,
  aucune logique de scan côté frontend (tout passe par l'API sémantique
  existante).
- **CA-9** : générateur de rapport HTML/JSON déterministe
  (`cyber-report.js`), échappement HTML systématique de toute donnée
  provenant de la cible, re-redaction en profondeur des preuves
  (défense en profondeur même si CA-5 a déjà redacté), aucune dépendance
  PDF ajoutée.
- **CA-10** : tests navigateur (Playwright) du Studio complet, tests de
  sécurité UI explicites (autorisation manquante bloque le démarrage,
  scope wildcard refusé, aucune méthode destructive possible depuis
  l'UI), régression complète Docteur (MetaGPT/Sherlock/Investment/
  Video/Command Center/Studios UX), typecheck, build.

## Rate limiting — historique de la correction (CA-7.1)

Le checkpoint CA-7 avait certifié l'orchestration et l'API sémantique
sans qu'un test ne démontre l'application réelle du débit de requêtes.
Ce n'était pas un défaut de sécurité réseau (aucune requête hors scope,
aucune méthode destructive) mais un écart entre ce que `validateScope()`
acceptait/persistait et ce que `cyber-gateway.js` appliquait réellement.
La mission CA-7.1 a explicitement demandé de corriger ce point avant de
commencer Cyber Studio/UI, ce qui a été fait avant CA-8. Le rapport ne
masque pas cet historique : **avant CA-7.1, l'énoncé « Rate limiting :
PASS » n'aurait pas dû être lu comme « appliqué au trafic réel »** —
seule la validation/persistance du paramètre avait été certifiée.
Depuis CA-7.1, l'application réelle est testée explicitement (19 tests
dédiés : 1 req/s, 2 req/s, valeur minimale/maximale, requêtes
concurrentes, redirections, annulation et timeout pendant l'attente,
absence de timer orphelin).

## Scope model

`cyber-policy.js` — `allowedHosts` (exact, pas de wildcard, sous-domaines
refusés par défaut sauf `followSubdomains: true` explicite),
`allowedPorts`, `allowedProtocols` (`http:`/`https:` uniquement),
`allowedPaths`/`excludedPaths` (préfixes), `maxDepth`/`maxRequests`/
`requestsPerSecond`/`timeoutMs` tous bornés par des caps serveur fixes
(`LIMITS`), jamais dépassables depuis le frontend ou depuis un scope
persisté plus permissif qu'aujourd'hui (revalidation au démarrage de la
mission).

## Network gateway

`cyber-gateway.js` — seul module autorisé à ouvrir une socket vers la
cible. `safeCyberFetch` (requêtes GET/HEAD avec suivi de redirection
revalidé à chaque hop), `safeCyberTlsInspect` (poignée de main TLS seule,
sans requête HTTP), `safeCyberCorsProbe` (OPTIONS synthétique). Chacune
des trois passe par `acquireRateLimitSlot()` avant d'ouvrir la socket.

## Crawler

`cyber-crawler.js` — file d'attente bornée (`BoundedCrawlQueue`),
canonicalisation prudente des URLs (host en minuscules, fragment
supprimé, query string triée et conservée), limite de variantes de query
par chemin, extraction de liens via `jsdom` sans exécution de script,
robots.txt/sitemap.xml traités comme données uniquement (jamais suivis
automatiquement au-delà de ce que la politique de scope autorise déjà).

## Detectors

`cyber-detect-tls.js`, `cyber-detect-headers.js`, `cyber-detect-cookies.js`,
`cyber-detect-cors.js`, `cyber-detect-info-disclosure.js` — fonctions
pures, jamais d'E/S réseau, chaque finding sépare `observed` (fait
constaté) et `interpretation` (hypothèse prudente), `CRITICAL` impossible
sans confiance `HIGH`.

## Evidence

`cyber-evidence.js` — seul point d'écriture des tables
evidence/findings, redaction inconditionnelle des en-têtes/extraits avant
persistance, extrait de réponse toujours tronqué (jamais le corps
complet), déduplication des findings par `(id, mission_id)` avec
`lastSeen` mis à jour plutôt qu'une nouvelle ligne.

## Reporting

`cyber-report.js` — pure fonction de données déjà persistées, aucune
E/S réseau, aucun appel détecteur. Sections obligatoires : Cover,
Mission, Authorization statement, Scope, Methodology, Limitations,
Executive summary, Risk distribution, Findings (WHAT/WHERE/WHY/EVIDENCE/
HOW TO FIX/SEVERITY/CONFIDENCE, observé/interprétation/recommandation
visuellement séparés), Evidence, Recommendations (règle de priorité
explicite et déterministe, jamais opaque), Appendix. Échappement HTML
systématique, re-redaction en profondeur des preuves, aucun `<script>`,
aucun gestionnaire d'événement inline, aucune ressource externe. PDF :
NOT IMPLEMENTED (aucune dépendance lourde ajoutée). Export CSV : non
ajouté (V1).

## UI (Cyber Audit Studio)

`CyberAuditStudioModal.tsx` — construit sur les primitives Studio
partagées (`StudioShell`/`StudioTabs`/`StudioStatus`/`StudioEmptyState`/
`StudioErrorState`/`StudioToolbar`), wizard en 6 étapes avec confirmation
d'autorisation obligatoire (case à cocher, texte exact requis par la
mission), scope affiché exactement tel qu'il sera envoyé (revue avant
démarrage), aucune valeur UI ne peut dépasser les caps serveur (vérifié
côté client ET revalidé côté serveur). Vue de scan en direct : uniquement
des données réelles (requêtes, pages, findings par sévérité) — jamais un
pourcentage fabriqué quand le total est inconnu. Bouton STOP AUDIT
toujours visible pendant RUNNING, appelle uniquement la route cancel
existante. RE-SCAN : NOT IMPLEMENTED (documenté explicitement dans
l'onglet History, jamais laissé implicite).

## Tests

- Backend Cyber : 271/271 (CA-3 à CA-9 combinés).
- Backend Docteur complet (certification) : 1061/1061.
- Navigateur Cyber Audit Studio : 25/25 (Playwright, backend mocké,
  desktop/mobile/clavier/piège de focus vérifiés via
  `studio-browser-checks.mjs`).
- Régression navigateur Docteur : MetaGPT 22/22, Sherlock 18/18,
  Investment 21/21, Video Studio 6/6, Dashboard 15/15, Studio Primitives
  29/29, Cortex Command Center 15/15.
- Typecheck : PASS. Build : PASS.

## Limitations (documentées, jamais masquées)

- Pas de pentest complet, pas d'exploitation, pas d'audit authentifié,
  pas de scan de ports, pas d'outils offensifs automatiques.
- Re-scan/comparaison entre missions : NOT IMPLEMENTED en V1.
- Export PDF : NOT IMPLEMENTED (aucune dépendance Puppeteer/Chromium
  ajoutée pour cela).
- L'absence de finding détecté ne signifie pas absence de vulnérabilité
  — c'est écrit explicitement dans chaque rapport généré.
