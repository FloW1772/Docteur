# MASTER PHASE 6 — Navigateur configurable

Date: 2026-09-15
Branche: `main` (diff isolé, non commité)

## 1. Clarification de portée (validée avec l'utilisateur)

Docteur est une web app (pas Electron) — les liens s'ouvrent normalement via
`window.open()` dans le navigateur déjà utilisé pour afficher Docteur, qui n'a aucun
contrôle possible sur "quel navigateur OS" gère un lien depuis l'intérieur d'une page web.
Confirmé avec l'utilisateur : le "choix du navigateur" de la mission désigne un mécanisme
**backend** — le serveur détecte les navigateurs installés, l'utilisateur choisit dans
Paramètres, et une action backend (`spawn`) peut ouvrir une URL dans ce navigateur précis,
indépendamment de celui affichant Docteur. Les liens `window.open()` existants dans l'app
(FreeAiFinder, SearchConsole, etc.) restent inchangés — cette phase ajoute l'infrastructure
sans forcer une migration de tous les liens existants (hors périmètre, risque de régression
inutile).

## 2. Ce qui a été construit

### 2.1 Détection des navigateurs installés
`cortex-server/src/lib/browser.js` :
- Liste figée de navigateurs connus (Edge, Chrome, Firefox, Brave) avec leurs chemins
  d'installation standards Windows (`Program Files`, `Program Files (x86)`, `LocalAppData`
  pour les installs par utilisateur).
- `detectInstalledBrowsers()` — **uniquement** `fs.existsSync()`, jamais d'exécution pour
  "sonder" — un navigateur n'apparaît que s'il est réellement présent sur le disque.
  `system` (gestionnaire d'URL par défaut de l'OS) toujours listé, sans chemin spécifique.
- Vérifié sur la machine réelle (lecture seule) : Edge, Chrome, Firefox et Brave
  correctement détectés avec leurs vrais chemins.

### 2.2 Validation d'URL stricte
`assertOpenableUrl()` : accepte uniquement `http:`/`https:` après un `new URL()` réel
(jamais de correspondance par sous-chaîne). Rejette explicitement `file:`, `javascript:`,
`data:`, `powershell:`, `cmd:`, `vbscript:`, `about:`, et toute URL malformée.

### 2.3 Ouverture sécurisée
`resolveOpenCommand()` retourne toujours `{ command, args }` — jamais une chaîne shell :
- `system` → `spawn(cmd.exe, ['/c', 'start', '', url], { shell: false })` (dispatch natif
  Windows, méthode documentée, sans interprétation shell de l'URL).
- Navigateur détecté → `spawn(cheminExe, [url], { shell: false })`.
- Chemin personnalisé → validé (`validateCustomBrowserPath` : absolu, `.exe`, fichier
  existant) avant tout spawn.
- `openUrlInSelectedBrowser()` = validation URL + résolution + spawn détaché
  (`detached: true, stdio: 'ignore'`, `child.unref()`) — le process Docteur ne bloque jamais
  en attendant le navigateur.

### 2.4 Route API
`cortex-server/src/routes/browser.js` :
- `GET /api/browser/installed`, `GET/PUT /api/browser/settings`, `POST /api/browser/open`.
- `PUT /settings` refuse un id de navigateur non détecté ou un chemin personnalisé invalide
  (jamais accepté silencieusement).

### 2.5 UI — Paramètres → Navigateur
`src/components/settings/BrowserSettingsSection.tsx` — boutons pour chaque navigateur
détecté + option "Personnalisé…" (champ de chemin), montée dans l'onglet MODÈLES juste
après la section NotebookLM.

## 3. Vérification visuelle (Playwright, base isolée)

Section Navigateur confirmée à l'écran : les 4 vrais navigateurs installés sur la machine
(Edge, Chrome, Firefox, Brave) + "Navigateur par défaut du système" (sélectionné par défaut).
Sélection de Firefox testée : le bouton passe en surbrillance, persisté côté serveur
(confirmé par un vrai appel PUT réussi contre la base de test isolée).

## 4. Tests

`test-phase6-browser.mjs` — **16/16 PASS** :
- Validation d'URL : accepte http/https, rejette tous les schémas dangereux listés par la
  mission (file, javascript, data, powershell, cmd) + vbscript/about en plus.
- URL malformée rejetée plutôt que transmise telle quelle.
- **Tentative d'injection d'argument** : une URL contenant des métacaractères shell
  (`"; rm -rf ~; #`) est neutralisée par le parsing `URL()` — testé explicitement.
- Détection : `system` toujours présent, tout autre navigateur listé n'a un chemin que s'il
  existe réellement sur disque (vérifié par `fs.existsSync` dans le test lui-même).
- Persistance des réglages, valeur par défaut `system`.
- Validation de chemin personnalisé : rejette vide, non-.exe, relatif, inexistant ; accepte
  un vrai `.exe` absolu existant.
- `resolveOpenCommand` : confirme la forme `{command, args}` (jamais une chaîne), le mode
  `system` utilise bien `cmd.exe /c start` avec un tableau d'arguments réel.
- Navigateur non installé sélectionné → erreur claire, jamais un spawn de "n'importe quoi".
- Intégration route complète : rejet 400 pour `javascript:`/`file:`, navigateur absent,
  chemin personnalisé invalide — jamais un crash serveur.

**Aucun test ne lance réellement un navigateur** (pour ne pas ouvrir de fenêtre pendant les
tests automatisés) — le mocking s'arrête juste avant le `spawn()` réel via les assertions
sur `resolveOpenCommand()` ; le `spawn` lui-même (une ligne, `shell:false` explicite) est
laissé tel quel et vérifié par lecture de code plutôt que par exécution.

Suite complète cumulée (Phases 0-6) : **209/209 PASS**, 0 régression.

## 5. Typecheck / Build

- `npx tsc --noEmit` → OK.
- `npm run build` → OK.

## GATE PHASE 6

| Critère | Résultat |
|---|---|
| Détection uniquement des navigateurs réellement installés | Conforme, vérifié sur machine réelle |
| URL valide (http/https) acceptée | Conforme |
| javascript:/file:/data:/powershell:/cmd: bloqués | Conforme, testé |
| Injection d'argument | Bloquée par `URL()` + `spawn(...,[...], {shell:false})`, testé |
| shell:true | 0 (grep + lecture de code confirmés) |
| Navigateur absent géré proprement | Conforme, testé (erreur claire, pas de crash) |
| typecheck / build | OK / OK |
| Régression | 0 (209/209 tests) |

**PASS**

**→ CONTINUE vers PHASE 7 (Sherlock OSINT).**
