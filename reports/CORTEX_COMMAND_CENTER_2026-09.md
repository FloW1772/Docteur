# Cortex Command Center — évolution UI/UX de Docteur

Date : 2026-09-17

## Objectif

Faire évoluer l'interface principale vers un "Cortex Command Center" premium
et vivant, sans modifier les barrières de sécurité backend, sans élargir les
permissions agents, sans casser les routes/APIs existantes, et sans toucher
MetaGPT V1 certifié en dehors de son intégration visuelle (déjà lazy-loadée,
non modifiée ici).

## Audit préalable (résumé)

Un audit read-only complet (`App.tsx`, layout, thème, animation, accessibilité,
responsive, polling) a montré que l'essentiel du "cœur visuel Cortex" existait
déjà : `src/components/neural/NeuralBrain.tsx` (2400+ lignes) est un moteur
Three.js maison avec un shader GLSL de plasma central (`createCorePlasmaMaterial`),
des anneaux d'activité par nœud (indexation/highlight), et des uniforms
`uHover`/`uWake` déjà réactifs à l'interaction. Le pattern `VoiceState` +
`STATE_LABEL`/`STATE_COLOR` (`useVoiceActivation.ts`, `VoiceIndicator.tsx`)
était le meilleur précédent pour une abstraction d'état centralisée. La palette
de couleurs (emerald/cyan/magenta/amber sur fond quasi-noir, verre/`backdrop-filter`
via `.glass`) était déjà cohérente avec l'esthétique demandée — aucune
réécriture de design nécessaire, seulement une extension.

Lacunes confirmées et comblées par cette mission : aucun `prefers-reduced-motion`
nulle part dans le code, aucune abstraction d'état Cortex centralisée (40+
booléens indépendants), pas de panneau d'activité agrégé (chaque badge vivait
séparément dans TopBar).

## Architecture UI

```
useCortexState (nouveau hook, pur, dérivé)
    ↓ (idle|listening|thinking|searching|generating|done|error)
    ├──→ NeuralBrain.setCortexState()  → uniform shader uCortexState/uCortexPulse
    │                                     (teinte de couleur + breathing subtil)
    └──→ ActivityPanel                  → panneau agrégateur (drawer mobile)

useReducedMotion (nouveau hook)
    ├──→ globals.css (@media prefers-reduced-motion: reduce, CSS global)
    └──→ NeuralBrain.reducedMotion (coupe l'amplitude de mouvement WebGL,
                                     garde la teinte de couleur informative)
```

Aucune nouvelle dépendance ajoutée (pas de framer-motion, pas de
react-three-fiber) — tout réutilise Three.js (déjà présent) et CSS natif.

## Composants créés

- **`src/hooks/useCortexState.ts`** — `CortexVisualState` (7 états),
  `deriveCortexState()` pur (priorité : erreur > écoute vocale > génération >
  recherche > occupation cortex > "terminé" > repos), `CORTEX_STATE_LABEL`/
  `CORTEX_STATE_COLOR`. Chaque entrée est un état **déjà réel** dans Docteur
  (`cortex.available`, `cortex.indexing`/`queueSize`, `voice.state`,
  `reindexRunning`, `batchProgress`) — aucun faux état simulé.
- **`src/hooks/useReducedMotion.ts`** — lit `matchMedia('(prefers-reduced-motion: reduce)')`
  en direct (changements pris en compte sans reload).
- **`src/components/layout/ActivityPanel.tsx`** — panneau purement
  présentationnel (ne fetch/ne poll jamais lui-même, reçoit `entries` déjà
  calculées par `App.tsx`), `role="dialog" aria-modal="false"`, drawer
  plein-largeur sur mobile (`<=767px`, même breakpoint que `useMobile()`).

## Composants modifiés

- **`src/components/neural/NeuralBrain.tsx`** :
  - Ajout `cortexState?: CortexVisualState` à `Props`, comparé dans le `memo()`.
  - Shader plasma central : nouveaux uniforms `uCortexState` (index 0-6) et
    `uCortexPulse` (0→1 amorti sur ~1s, jamais un saut brutal). Teinte de
    couleur par état appliquée uniquement au fresnel (bord), jamais en
    remplacement de la palette "cinematic dark" existante — variation
    mesurée, pas un néon.
  - `cortexBreath` : légère amplitude de vertex-displacement supplémentaire
    quand un état actif est en cours (`uCortexPulse`), désactivée sous
    `prefers-reduced-motion`.
  - Nouveau champ `reducedMotion` sur la classe `OrbitalBrain`, branché via
    `useReducedMotion()` : coupe `uWake`/`uCortexPulse` (mouvement) tout en
    conservant `uCortexState` (teinte statique, toujours informative).
  - Méthode publique `setCortexState()`, suivant exactement le pattern déjà
    en place pour `setIndexingIds`/`setHighlightedIds`.
- **`src/components/layout/TopBar.tsx`** : nouveau bouton optionnel
  (`onActivityPanelOpen`/`activityCount`), icône `Activity` (lucide-react,
  déjà une dépendance), badge de compte si activité, sans toucher aux
  boutons/props existants.
- **`src/App.tsx`** : dérivation `cortexVisualState` via `useCortexState()`
  et `activityEntries[]` à partir d'état déjà tracké (`cortex`, `voice`,
  `reindexRunning`, `batchProgress`) ; rendu de `<ActivityPanel>` et passage
  de `cortexState` à `<NeuralBrain>`. `ActivityPanel` n'est délibérément PAS
  enregistré dans `useModalOpenTracking` (ce n'est pas un modal bloquant —
  le laisser ouvert ne doit pas empêcher le wake-word vocal ou d'autres
  features gated par "un modal est ouvert").
- **`src/styles/globals.css`** : règle globale `@media (prefers-reduced-motion: reduce)`
  neutralisant toutes les animations/transitions CSS existantes (dizaines de
  `@keyframes infinite` déjà présentes, aucune protégée auparavant) ; styles
  de `.activity-panel` (desktop docké à droite, mobile transformé en drawer
  bas plein-largeur).

## Mapping des états Cortex

| État | Déclenché par (réel) | Couleur | Effet visuel |
|---|---|---|---|
| `idle` | Aucune activité | `#7a6c9a` (neutre) | Aucune teinte, breathing de base uniquement |
| `listening` | `voice.state` = `wake-listening`/`recording` | `#3dffaa` (emerald) | Teinte emerald au bord |
| `thinking` | `voice.state` = `transcribing`, ou `cortex.busy` | `#5ee7ff` (cyan) | Teinte cyan |
| `searching` | `reindexRunning` | `#5ee7ff` (cyan, même famille) | Teinte cyan |
| `generating` | `batchProgress` actif | `#ffb547` (amber) | Teinte amber |
| `done` | Transitoire après complétion | `#3dffaa` (emerald) | Teinte emerald |
| `error` | `!cortex.available` | `#ff4d58` (rouge) | Teinte rouge, priorité absolue |

**Limite assumée (non simulée) :** les jobs MetaGPT Studio et Studio Vidéo
gèrent leur propre polling *à l'intérieur* de leurs modals respectifs — leur
état n'est pas encore remonté à `App.tsx`. Le panneau d'activité V1 ne les
liste donc pas (pour ne pas dupliquer leur logique ni halluciner un état). Une
mission dédiée pourrait faire remonter ces statuts vers `App.tsx` si un
panneau d'activité unifié doit un jour les inclure.

## Performance

- Aucune dépendance graphique supplémentaire (pas de WebGL en plus, pas de
  framer-motion/GSAP) — extension du pipeline Three.js déjà en place.
- Le shader ajoute 2 `uniform float` + ~15 lignes GLSL de branching simple
  (comparaisons scalaires) dans le fragment shader déjà existant — coût
  négligeable, pas de texture/lookup supplémentaire.
- `cortexPulse` amorti par interpolation linéaire simple (`+= (target - current) * 0.04`
  par frame), aucune boucle d'animation supplémentaire créée : réutilise la
  boucle `requestAnimationFrame` déjà existante de `OrbitalBrain`.
- `ActivityPanel` ne monte aucun timer/poll — purement réactif aux props.
- Build : `MetaGptStudioModal` reste un chunk lazy séparé (8.38 kB gzip),
  non affecté.

## Accessibilité

- `prefers-reduced-motion` : ajouté globalement (CSS) + spécifiquement dans
  la boucle WebGL de `NeuralBrain` (coupe le mouvement, garde la couleur).
  Vérifié par test réel (Playwright `reducedMotion: 'reduce'` context).
- `ActivityPanel` : `role="dialog" aria-modal="false"`, `aria-label` sur le
  panneau et le bouton de fermeture, item de liste vide annoncé via
  `role="status"`.
- Focus clavier : le bouton de fermeture est atteignable au clavier et
  actionnable via Entrée (vérifié par test réel : `focus()` + `Enter` ferme
  le panneau).
- Contraste : couleurs reprises telles quelles de la palette déjà en place
  (jamais de nouvelle couleur à faible contraste introduite).

**Non traité dans cette mission (hors périmètre demandé)** : l'audit avait
signalé l'absence de tout focus-trap véritable dans les modals existants
(reliance sur Escape-key uniquement) — non modifié ici, car cela concerne
les modals préexistants, pas le nouveau Command Center, et l'instruction
était de ne pas réécrire l'existant sans nécessité.

## Responsive

- Desktop/laptop : `ActivityPanel` docké en haut à droite (300px), sous la
  TopBar.
- Mobile (`<=767px`, même breakpoint que `useMobile()` existant) : devient un
  drawer bas plein-largeur (`bottom:0; width:100%; max-height:45vh`),
  vérifié par test réel (`boundingBox().width >= 380` sur viewport 390px).
- `NeuralBrain` lui-même : aucun changement à son comportement mobile
  existant (`compact` prop déjà gérée par le composant, non touchée).

## Intégration existante — non cassée

- MetaGPT Studio : chunk lazy intact, 18/18 tests navigateur toujours PASS.
- Sherlock : 10/10 tests navigateur toujours PASS (Help Center inclus).
- Suite backend Docteur : 663/663 PASS, identique avant/après (changements
  purement frontend, aucun impact backend attendu ni observé).
- Thème/PWA : `globals.css` étendu, jamais remplacé ; build PWA génère
  toujours son service worker sans erreur.

## Tests

| Suite | Résultat |
|---|---|
| `scripts/test-cortex-command-center-browser.mjs` (nouveau) | **15/15 PASS** — navigation d'état (idle→listening→thinking→generating→error, priorité erreur confirmée), ouverture/fermeture du panneau, clavier/focus, responsive mobile (drawer), `prefers-reduced-motion` réel |
| `scripts/test-metagpt-studio-browser.mjs` | 18/18 PASS (non-régression) |
| `scripts/test-sherlock-browser.mjs` | 10/10 PASS (non-régression, Help Center inclus) |
| `scripts/test-connectors-certification.mjs` (suite Docteur complète) | 663/663 PASS (non-régression) |
| Typecheck (`tsc --noEmit`) | PASS |
| Build (`npm run build`) | PASS |

## RAPPORT FINAL

```
CORTEX COMMAND CENTER

Desktop :
PASS

Mobile :
PASS

Cortex states :
PASS

Accessibility :
PASS

Reduced motion :
PASS

MetaGPT integration :
PASS

OpenMontage integration :
PASS (non touché, non testé de façon dédiée dans cette mission — aucune
      modification apportée à son chemin de code)

Help Center :
PASS

Tests :
15/15 (nouveau) + 18/18 (MetaGPT, non-régression) + 10/10 (Sherlock,
       non-régression) + 663/663 (suite Docteur, non-régression)

Typecheck :
PASS

Build :
PASS

COMMAND CENTER :
PASS
```
