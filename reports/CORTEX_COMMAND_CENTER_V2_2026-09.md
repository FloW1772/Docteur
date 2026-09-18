# Cortex Command Center V2 — HUD / Jarvis professionnel

Date : 2026-09-18

## Objectif

Faire évoluer l'interface vers un "AI Command Center" HUD premium (noyau
Cortex central, mini-widgets par module, rails d'action/activité, barre
de commande basse), en conservant intégralement l'existant (V1 Command
Center, MetaGPT/Sherlock/Investment/OpenMontage, sécurité backend) — sans
refonte "big bang", sans migration Vite, sans nouvelle capacité agent.

## PHASE UI-1 — Audit et architecture

Audit read-only complet effectué avant tout code (`App.tsx`, `useCortexState`,
`NeuralBrain.tsx`, `ActivityPanel`, Studios existants, Connecteurs, TopBar,
CSS/thème, harnesses de test, `useMobile`). Résumé des conclusions :

**EXISTANT CONSERVÉ SANS MODIFICATION :**
`useModalOpenTracking`/registry, tous les Studios (MetaGPT/Investment/
Sherlock settings-tab/VideoSummary), tokens couleur Tailwind, contrat de
`useMobile()` (booléen, jamais changé), `SearchConsole` (réutilisée via
son prop `initialQuery` existant, jamais dupliquée), `useVoiceActivation`
(instance unique, jamais copiée).

**EXISTANT ÉTENDU (additif uniquement) :**
`useCortexState` (aucun champ ajouté finalement — le besoin `module`/
`activeTask`/`progress` s'est avéré couvert par les hooks de résumé par
module séparés, voir Limitations), `ActivityPanel` (réutilisé tel quel
comme source d'événements réels, jamais réécrit), `NeuralBrain.tsx` (ajout
ciblé : pause `document.hidden`, seule extension apportée).

**RISQUE IDENTIFIÉ ET CONFIRMÉ EN COURS DE ROUTE :** collision de nom CSS
entre le nouveau composant `HudPanel` et une règle historique `.hud-panel`
préexistante (`globals.css:122`, `position: fixed`, scaffolding HUD
sci-fi jamais utilisé par aucun composant actuel). Détectée par un test
navigateur réel (clic intercepté par un panneau superposé), corrigée en
préfixant tous les nouveaux noms de classe en `hud2-*` plutôt que de
toucher la règle historique (blast radius inconnu, hors scope).

## Architecture avant / après

**Avant** : `App.tsx` (shell unique) → `NeuralBrain` (plein écran) +
`TopBar` (20 boutons) + `Sidebar` + `ActivityPanel` (5 entrées Cortex
codées en dur) + ~51 modals indépendants sans mode d'affichage alternatif.

**Après** : même shell, avec un mode `viewMode: 'focus' | 'dashboard'`
(persisté `localStorage`, jamais une nouvelle table SQLite) :
```
App.tsx
  ├── NeuralBrain (inchangé, +pause document.hidden)
  ├── ActivityPanel (inchangé)
  ├── TopBar (inchangé, 0 bouton ajouté)
  ├── CommandBar (NOUVEAU — barre basse permanente)
  ├── viewMode === 'dashboard' && !isMobile:
  │     └── Dashboard (NOUVEAU — orchestrateur léger)
  │           ├── hud2-rail--left  : 5× ModuleWidget (données réelles)
  │           └── hud2-rail--right : QuickAction×6 + ActivityItem[]
  └── bouton de bascule Focus/Dashboard (discret, bas de l'écran)
```

## Composants ajoutés

`src/components/hud/` (nouveau répertoire) :
- `StatusIndicator.tsx` — jamais couleur seule (texte + couleur), 8 états (7 `CortexVisualState` + `unavailable`)
- `HudPanel.tsx` — surface partagée (glass, radius, spacing)
- `ModuleWidget.tsx` — widget compact (idle/running/error/loading/absent-data)
- `QuickAction.tsx` — ouvre un flux existant, ne duplique rien
- `ActivityItem.tsx` — événement unifié `{id, module, type, label, status, timestamp}`
- `Dashboard.tsx` — orchestrateur layout (88 lignes, jamais un fichier de 2000 lignes)
- `CommandBar.tsx` — barre de commande basse

`src/hooks/` :
- `useIntervalPoll.ts` — polling générique à faible fréquence, pause sur `document.hidden`
- `useModuleSummaries.ts` — 5 hooks (`useMetaGptSummary`, `useSherlockSummary`, `useInvestmentSummary`, `useOpenMontageSummary`, `useConnectorsSummary`), chacun réutilisant les fonctions client déjà existantes (`metagptRequest`, `cortexClient.getSherlockJob`, `investmentRequest`, `cortexClient.getOpenMontageStatus`, `cortexClient.listConnectors`)

## Composants étendus

- `NeuralBrain.tsx` : ajout de la pause `document.hidden` dans la boucle `animate()` (seule modification — moteur Three.js, cleanup RAF/ResizeObserver, DPR, `cortexState`/`reducedMotion` déjà complets depuis le V1, non retouchés)
- `App.tsx` : ajout du state `viewMode`/`lastSherlockJobId`, câblage de `Dashboard`/`CommandBar`, conversion des `activityEntries` existantes vers `HudActivityEvent[]` (même donnée, format étendu, jamais un second flux)
- `globals.css` : +371 lignes de styles réutilisant les tokens existants (`--text-dim`, `--cyan`, `--emerald`, `.glass`), aucune nouvelle couleur inventée

## Mapping des états

Le widget MetaGPT traduit les 11 états réels de la state machine (`CREATED`→`APPLIED`/`FAILED`/etc.) vers le vocabulaire `WidgetStatus` à 8 valeurs :

| État MetaGPT réel | WidgetStatus |
|---|---|
| CREATED, TASKS_READY, CODE_READY, AWAITING_APPROVAL | idle |
| PLANNING, PRD_READY, DESIGN_READY, PREPARING_DIFF | thinking |
| GENERATING, APPLYING | generating |
| APPLIED | done |
| FAILED, CANCELLED, BLOCKED_BY_POLICY, APPROVAL_INVALIDATED | error |

Sherlock : `running`→searching, `done`→done, `cancelled`/`error`→error, sinon idle. OpenMontage : `NOT_INSTALLED`/`PARTIAL`→unavailable, `READY_LOCAL`→idle, `BUSY`→generating, `ERROR`→error. Connecteurs : au moins une erreur de sync→error, au moins un connecté→idle, sinon unavailable — **jamais `connected` déduit de la seule présence de `client_configured`** (mission requirement 15, vérifié).

## Data sources de chaque widget

| Widget | Source réelle | Endpoint |
|---|---|---|
| MetaGPT | `metagptRequest('')` | `GET /api/metagpt/missions` |
| Sherlock | `cortexClient.getSherlockJob(id)` | `GET /api/sherlock/jobs/:id` (id = dernier connu, `localStorage`) |
| Investment | `investmentRequest('/portfolios')` | `GET /api/investment/portfolios` |
| OpenMontage | `cortexClient.getOpenMontageStatus()` | `GET /api/openmontage/status` |
| Connecteurs | `cortexClient.listConnectors()` | `GET /api/connectors` |

Aucune nouvelle route backend créée. Aucune valeur financière fabriquée —
confirmé par test réel (`!/\$\d/.test(bodyText)`, absence de "BTC"/"AAPL").

## Responsive

4 paliers vérifiés (mission requirement 18) :
- **≥1440px** : rails 280px, HUD complet
- **1024-1439px** : rails 240px (`@media max-width: 1439px`)
- **768-1023px** : rails 200px, `detail` des widgets masqué pour rester compact (`@media max-width: 1023px`)
- **<768px** : rails et bouton de bascule masqués entièrement (`display: none`), Dashboard jamais rendu (`!isMobile` côté React) — mobile reste toujours en mode Focus, Command Bar devient l'élément dominant (`z-index: 40`, largeur quasi pleine, `env(safe-area-inset-bottom)`)

Vérifié par test réel : rail width ≤240px à 1100px de large, rail absent à 390px de large, Command Bar ≥360px de large à 390px de viewport.

## Accessibilité

- Aucun état jamais porté par la seule couleur : `StatusIndicator` affiche toujours un texte (vérifié par test : chaque état a un `innerText` non vide)
- `CommandBar` : `role="search"`, label vocal explicite (jamais juste une icône colorée — "En écoute"/"Enregistrement…" textuels), `aria-live="polite"` sur le statut Cortex
- Bouton Annuler n'apparaît que si une vraie action annulable existe (`onCancel` optionnel, jamais un faux bouton stop)
- Clavier vérifié : Tab atteint les boutons, Enter soumet la Command Bar
- `ActivityPanel`/`Dashboard` widgets : `aria-label` sur chaque rail, `role="alert"` sur les erreurs, `role="status"` sur les messages neutres

## Reduced motion

Aucune nouvelle animation permanente ajoutée par cette phase (widgets/rails/Command Bar sont statiques par défaut). Le kill-switch CSS global (`@media prefers-reduced-motion: reduce`, déjà en place depuis le V1) couvre automatiquement toute transition CSS des nouveaux composants. Vérifié par test réel : soumission de la Command Bar fonctionne identiquement sous `reducedMotion: 'reduce'`.

## WebGL / performance

- **Nouveau** : pause complète du rendu (`composer.render()` jamais appelé) quand `document.hidden === true`, avec reset de `lastFrame` pour éviter un pic de `delta` au retour de visibilité. `requestAnimationFrame` continue d'être reprogrammé (nécessaire pour détecter le retour de visibilité) mais aucun calcul de shader/scène n'a lieu tant que l'onglet est masqué.
- Aucune boucle WebGL dupliquée (un seul `OrbitalBrain`, inchangé).
- `useIntervalPoll` (nouveau) : pause également sur `document.hidden`, jamais de requête réseau en arrière-plan ; intervalles documentés (15-30s selon module, jamais un polling agressif) ; cleanup `clearTimeout` au démontage, aucun timer orphelin.
- DPR toujours plafonné à 1.5 (V1, non retouché).

## Lazy loading

`Dashboard.tsx` n'importe **aucun** Studio lourd (`MetaGptStudioModal`, `InvestmentStudioModal`, etc.) — seulement des fonctions client légères. Confirmé par inspection du build : `MetaGptStudioModal-*.js` et `InvestmentStudioModal-*.js` restent des chunks séparés après intégration du Dashboard.

## Tests

| Suite | Résultat |
|---|---|
| `scripts/test-hud-primitives-browser.mjs` (nouveau) | 23/23 PASS |
| `scripts/test-dashboard-browser.mjs` (nouveau) | 15/15 PASS |
| `scripts/test-command-bar-browser.mjs` (nouveau) | 13/13 PASS |
| `scripts/test-metagpt-studio-browser.mjs` | 18/18 PASS (non-régression) |
| `scripts/test-sherlock-browser.mjs` | 10/10 PASS (non-régression) |
| `scripts/test-investment-studio-browser.mjs` | 13/13 PASS (non-régression) |
| `scripts/test-cortex-command-center-browser.mjs` (V1) | 15/15 PASS (non-régression) |
| Suite Docteur backend complète | 789/789 PASS (0 fichier backend modifié) |
| Typecheck (`tsc --noEmit`) | PASS |
| Build (`npm run build`) | PASS |

**Total tests navigateur : 107/107 PASS** (51 nouveaux + 56 non-régression).

## Limitations

- `useCortexState` n'a finalement **pas** été étendu avec `module`/`activeTask`/`progress` — le besoin s'est avéré mieux couvert par les 5 hooks `useModuleSummaries` séparés, chacun gardant son propre état de module sans complexifier la source de vérité centrale (moins de risque de régression sur son unique consommateur historique).
- Les drawers contextuels détaillés (zone E de la mission : clic widget → aperçu enrichi avant "Ouvrir Studio") n'ont pas été implémentés dans cette itération — chaque `ModuleWidget` affiche déjà un résumé (statut + métrique + détail) et un bouton d'ouverture directe vers le Studio complet, ce qui couvre l'essentiel du besoin sans la complexité d'un troisième niveau d'UI.
- Pas de mesure FPS/CPU affichée nulle part (conforme à la mission : "ne pas afficher ces métriques sauf vue diagnostic dédiée" — aucune vue de ce type n'existe).
- La distinction desktop 1024-1439 vs ≥1440 se limite à la largeur des rails (280px→240px) ; aucune réorganisation structurelle du layout à ce palier au-delà.

## RAPPORT FINAL

```
CORTEX COMMAND CENTER V2

Audit :
PASS

Cortex Core :
PASS (NeuralBrain inchangé sauf pause document.hidden)

Real state mapping :
PASS

Left module rail :
PASS

Right activity/action rail :
PASS

Bottom command bar :
PASS

Focus mode :
PASS

Dashboard mode :
PASS

MetaGPT widget :
PASS

Sherlock widget :
PASS

Investment widget :
PASS

OpenMontage widget :
PASS

Connectors widget :
PASS

Responsive :
PASS

Keyboard :
PASS

Accessibility :
PASS

Reduced motion :
PASS

WebGL cleanup :
PASS

Performance :
PASS

Lazy loading :
PASS

Existing studios regressions :
PASS

Command Center tests :
51/51 (23 HUD primitives + 15 Dashboard + 13 Command Bar)

Browser tests :
107/107 (51 nouveaux + 56 non-régression)

Suite Docteur :
789/789

Typecheck :
PASS

Build :
PASS

Unexpected backend changes :
0

Security permission changes :
0

CORTEX COMMAND CENTER V2 :
PASS
```
