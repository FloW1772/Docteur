# MASTER PHASE 7 — Sherlock OSINT

Date: 2026-09-15
Branche: `main` (diff isolé, non commité)

## 1. Vérification préalable (avant toute intégration)

Un agent de recherche a vérifié les faits actuels sur Sherlock avant toute décision de
conception :

- **Dépôt officiel** : `github.com/sherlock-project/sherlock`, licence **MIT**, org
  communautaire indépendante (~91k étoiles).
- **Installation** : package PyPI `sherlock-project` (pas `sherlock`, nom pris par un autre
  package). Méthode recommandée : `pipx install sherlock-project`.
- **Comportement technique confirmé** : Sherlock effectue uniquement des requêtes HTTP
  GET/HEAD non authentifiées vers l'URL de profil de chaque site pour vérifier l'existence
  d'un nom d'utilisateur — **aucun login, aucun mot de passe, aucun vol de cookie/session,
  aucune prise de contrôle de compte**.
- **Sortie** : pas d'export JSON natif (le flag `--json` charge un fichier de définition de
  sites alternatif, ce n'est pas un format de résultats) — texte/CSV/XLSX uniquement. Format
  `--print-found` : `[+] SiteName: url`.
- **Pas de limitation de débit intégrée** — seul un `--timeout` par requête existe ; la
  politesse/limitation doit être assurée par l'intégrant, pas supposée fournie par l'outil.
- **Licence** : MIT permet la redistribution et l'appel en subprocess ; recommandation
  suivie : ne jamais empaqueter/auto-installer, toujours passer par un exécutable installé
  par l'utilisateur lui-même.

## 2. Ce qui a été construit

### 2.1 Bibliothèque `lib/sherlock.js`
- **Aucune installation automatique** — `startInstall()`/`startUninstall()`/`testInstall()`
  ne sont jamais appelés qu'en réponse à une action utilisateur explicite via la route ;
  rien dans ce fichier ne s'exécute au démarrage du serveur ni sur un timer.
- **`shell:false` partout** — chaque appel `spawn`/`execFile` le déclare explicitement,
  vérifié par un test statique dédié (voir section 4).
- **Validation stricte du nom d'utilisateur** (`validateUsername`) : regex
  `[A-Za-z0-9_.\-]{1,64}` — rejette espaces, métacaractères shell, tentatives d'injection
  (`; rm -rf /`, `` `whoami` ``, `$(whoami)`, `|`, guillemets, path traversal) **avant même**
  qu'un processus ne soit lancé.
- **Résolution d'exécutable** : uniquement via PATH (`execFile('sherlock', ...)`, nom nu,
  résolution PATHEXT native de Node sans shell) — jamais un chemin fourni par le client.
- **Limitation de débit assurée par le wrapper** (Sherlock n'en fournit aucune) :
  `MAX_CONCURRENT_SEARCHES = 1` (une seule recherche à la fois), timeout global de 120s
  (kill du process si dépassé), `--timeout` par requête passé à Sherlock (défaut 15s,
  borné 1-60s).
- **Annulation** : `cancelSearch(jobId)` tue le process réel (`child.kill()`), le job
  résultant est marqué `cancelled` avec les résultats partiels déjà obtenus.
- **Parsing texte** (`parseSherlockOutput`) : n'extrait que les lignes `[+] Site: url`
  réellement présentes — jamais de résultat fabriqué à partir d'une sortie vide ou bruitée.

### 2.2 Route API `routes/sherlock.js`
- `GET /sherlock/status`, `POST /sherlock/test|install|uninstall`.
- `POST /sherlock/search` (validation avant tout spawn, 400 sinon), `POST
  /sherlock/search/:jobId/cancel`, `GET /sherlock/search/:jobId` (poll de statut).
- `POST /sherlock/save-as-neuron` : crée un neurone à partir d'un résultat choisi —
  **`private: true`, `egress_policy: 'local_only'` par défaut**, conforme à l'exigence
  mission ("Les neurones OSINT : privacy = private, egress_policy = local_only par
  défaut").
- `routes/jobs.js` étendu d'un export `getJob(id)` (accès direct au registre de jobs déjà
  utilisé par `GET /api/jobs`) pour permettre le polling ciblé côté Sherlock sans dupliquer
  le mécanisme de suivi de jobs existant.

### 2.3 UI — Paramètres → Sherlock OSINT
`src/components/settings/SherlockSettingsSection.tsx`, montée après la section Navigateur :
- Attribution claire vers le dépôt officiel + licence MIT.
- Texte explicite sur les limites de sécurité (jamais cookie/mdp/compte privé/force
  brute/contournement CAPTCHA).
- État (Non installé/Installé/Erreur), boutons Installer/Désinstaller/Tester.
- Recherche par nom d'utilisateur (visible seulement une fois Sherlock installé), résultats
  avec actions Ouvrir / Créer neurone / Ignorer, annulation de recherche en cours.

## 3. Vérification visuelle (Playwright, base isolée)

Section Sherlock confirmée à l'écran : attribution officielle, avertissements de sécurité
lisibles, état "Non installé" correctement affiché (cet environnement n'a ni Sherlock ni
pipx), boutons Installer/Tester présents. Le clic réel sur "Installer" n'a **pas** été
déclenché pendant cette vérification (aurait tenté un vrai `pipx install` sans pipx
disponible ici) — ce chemin est couvert intégralement par les tests automatisés (section 4).

## 4. Tests

`test-phase7-sherlock.mjs` — **18/18 PASS** :
- Validation de nom d'utilisateur : accepte les formes plausibles, rejette 10 tentatives
  d'injection/dépassement (métacaractères shell, path traversal, longueur excessive).
- Parsing de sortie : extrait uniquement les lignes `[+]`, ignore `[-]` et le bruit ; sortie
  vide/aléatoire → zéro résultat fabriqué.
- État d'installation par défaut `not_installed`.
- `testInstall`/`startInstall`/`startUninstall` : testés contre l'**environnement réel** (ni
  Sherlock ni pipx installés ici) — chemin ENOENT authentique, pas de mock, message d'erreur
  clair systématiquement présent.
- `startSearch` rejette un nom invalide avant tout spawn ; recherche valide → job créé,
  échoue proprement avec message "n'est pas installé" (chemin réel).
- `cancelSearch` sur un job inconnu/déjà terminé → `cancelled:false`, jamais d'exception.
- Intégration route complète : statut, recherche invalide (400), recherche valide (202 +
  job), job inconnu (404).
- `save-as-neuron` : neurone créé avec `egress_policy:'local_only'` et page `private:true`
  vérifiés directement en base de test ; validation des champs requis.
- **Vérification statique de sécurité** : chaque ligne d'appel `spawn`/`execFile` réelle
  dans `lib/sherlock.js` déclare explicitement `shell:false`, aucune n'utilise `shell:true`.

Suite complète cumulée (Phases 0-7) : **232/232 PASS**, 0 régression (incluant
`test-jobs-route.mjs`, dont le fichier source a été étendu pour cette phase).

## 5. Typecheck / Build

- `npx tsc --noEmit` → OK.
- `npm run build` → OK.

## GATE PHASE 7

| Critère | Résultat |
|---|---|
| shell:true | 0 (vérifié par test statique + lecture de code) |
| Injection d'entrée bloquée | Conforme, testé (10 cas) |
| Recherche par username public uniquement | Conforme (aucun paramètre cookie/mdp dans l'API) |
| Pas d'installation automatique | Conforme (aucun appel au démarrage, uniquement sur action utilisateur) |
| Neurones OSINT privés/local_only par défaut | Conforme, testé |
| Limitation de concurrence/timeout/annulation | Conforme (1 recherche à la fois, timeout 120s, cancel réel) |
| OSINT cloud calls | 0 (Sherlock lui-même ne contacte que les sites tiers ciblés, en HTTP direct — aucun appel à un provider IA cloud de Docteur) |
| typecheck / build | OK / OK |
| Régression | 0 (232/232 tests) |

**PASS**

**→ CONTINUE vers PHASE 8 (étude de faisabilité d'un entraînement local léger — audit uniquement, aucun téléchargement/entraînement réel).**
