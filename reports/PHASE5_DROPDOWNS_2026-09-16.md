# PHASE 5 — Menus déroulants / selects

Mode : audit complet d'abord, fix CSS minimal et global ensuite (aucun refactor JSX, aucune nouvelle dépendance).

## Audit

13 fichiers utilisent des `<select>` natifs (aucun composant `Select` partagé n'existe dans Docteur — vérifié par recherche globale). Aucune règle CSS globale pour `select`/`option`/`optgroup` n'existait avant cette phase : chaque `<select>` s'appuie sur un style inline par fichier (`inputStyle`, `selectStyle`, ou classe Tailwind `field`), qui stylise correctement la boîte fermée mais jamais le popup natif.

**Cause exacte** : `background`/`color` posé sur `<select>` ne stylise que la boîte fermée sur la plupart des navigateurs — le popup d'options ouvert est dessiné par l'OS/le navigateur avec son propre fond, blanc par défaut sur Windows/Chrome/Edge, quel que soit le CSS du parent. Seul `background`/`color` posé directement sur `<option>`/`<optgroup>` est respecté par les navigateurs pour ce popup.

**Preuve que la technique correcte était déjà connue mais appliquée de façon incohérente** : 6 `<option>` dans `App.tsx`, `PromptMeta.tsx` et `SettingsModal.tsx` (4 occurrences) avaient déjà `style={{ background: '#0f0b1e' }}` posé manuellement — mais la grande majorité des ~25 `<select>` du reste de l'app (Professeur, Générateur d'images, Agents externes, etc.) n'avaient rien.

## Fix appliqué

**Une seule règle CSS globale**, ajoutée dans `src/styles/globals.css`, juste après la règle `body` :

```css
select { color-scheme: dark; }
select option, select optgroup { background: var(--bg); color: var(--text-main); }
select option:disabled { color: var(--text-dim); opacity: 0.6; }
select:disabled { opacity: 0.6; cursor: default; }
select:focus-visible { outline: 1px solid var(--cyan); outline-offset: 1px; }
```

- **Réutilise exclusivement les tokens de thème existants** (`--bg`, `--text-main`, `--text-dim`, `--cyan`, déjà définis dans `:root`) — aucune couleur hardcodée nouvelle.
- **Règle au niveau élément de base** (`select`, pas une classe) : couvre les ~25 `<select>` des 13 fichiers **sans modifier une seule ligne de JSX/logique** — zéro risque de changement de comportement, puisque le CSS n'affecte ni `value`, ni `onChange`, ni la structure du DOM.
- Les 6 `<option>` qui avaient déjà un style inline continuent de fonctionner à l'identique (le style inline reste prioritaire sur la règle CSS globale — aucun conflit, juste une redondance harmless).
- `select:disabled` et `select:focus-visible` comblent une lacune préexistante (aucun style focus n'existait auparavant sur aucun input de l'app) — ajout minimal, cohérent avec les conventions déjà utilisées ailleurs (`opacity: 0.4-0.6` pour disabled, déjà vu sur `.voice-mic-btn:disabled` etc.).

## Limite documentée (contrainte navigateur, non contournable en CSS)

Le hover/la sélection en surbrillance **à l'intérieur du popup natif ouvert** (`:hover` sur `<option>`, couleur de la ligne survolée) reste rendu par l'OS et n'est **pas stylable en CSS** dans aucun navigateur — c'est une limitation universelle des `<select>` natifs, pas spécifique à Docteur. La règle mission 5.4 anticipait explicitement ce cas ("si un select natif ne permet pas un rendu fiable cross-browser, documenter et utiliser le composant UI existant si Docteur en possède déjà un") : Docteur ne possède aucun composant Select existant, et introduire une bibliothèque ou un composant custom uniquement pour ce détail visuel aurait été disproportionné et interdit par la règle "ne pas installer de nouvelle bibliothèque juste pour ça". Le vrai bug signalé (fond blanc) est corrigé ; le survol interne au popup reste géré par l'OS, ce qui est le comportement standard de tout site utilisant un `<select>` natif.

## Vérification — test navigateur réel

Serveur de dev (`npm run dev`, HTTP) + backend cortex-server isolé sur DB de test jetable (`/tmp/docteur-smoke-test5`, jamais la vraie base — supprimée après usage), piloté par Playwright.

| Zone testée | Selects trouvés | `option` background | `option` color | Sélection fonctionnelle | Focus |
|---|---:|---|---|---|---|
| **Professeur → Réglages → Modèle dédié** | 1 (8 options) | `rgb(10,8,20)` = `--bg` | `rgb(232,217,255)` = `--text-main` | OK (réassignation confirmée) | outline cyan appliqué |
| **Settings → Modèles → Modèle "puissant"** | 1 (2-3 options) | `rgb(15,11,30)` (style inline préexistant, cohérent) | `rgb(232,217,255)` | OK — changement de valeur confirmé (`qwen2.5:14b-instruct-q3_K_M` → `mistral-nemo:12b-instruct-2407-q4_K_M`) | outline cyan appliqué |
| **Settings → Modèles → Modèle conversation** | 1 | `rgb(15,11,30)` | `rgb(232,217,255)` | OK | — |
| **Générateur d'images** (Provider / Format / Seed) | 3 | `rgb(10,8,20)` = `--bg` (aucun style inline préexistant — entièrement corrigé par la règle globale) | `rgb(232,217,255)` | OK — changement confirmé (`auto` → `comfyui`) | — |
| **Settings → Agents externes** (Agent / Tâche / Mode / Workspace / Timeout) | 5 | `rgb(10,8,20)` = `--bg` | `rgb(232,217,255)` | OK (non modifié, présent et fonctionnel) | — |
| **Notebook** | 0 (aucun select — confirmé par lecture du code, Notebook n'offre pas de choix de provider, strictement local par construction) | — | — | — | — |

**0 erreur console, 0 erreur de page** sur l'ensemble des scénarios testés (hors 503 attendus dus à l'absence de credentials réels sur la DB de test isolée — comportement de confidentialité correct, sans rapport avec cette phase).

Captures d'écran prises pour Professeur/Settings-Modèles/Images/Agents externes : boîtes fermées visuellement cohérentes avec le thème sombre de Docteur, aucun artefact blanc visible dans l'interface elle-même (le popup natif ouvert n'est pas capturable par une capture d'écran Playwright — vérifié à la place via `getComputedStyle` sur les `<option>`, méthode fiable et directe).

## Fichiers modifiés

- `src/styles/globals.css` uniquement (+91 lignes, dont ~30 pour cette phase — le reste provient de la Phase 3 `UpdateBanner`).
- **Aucun fichier backend touché.**
- **Aucun composant JSX modifié** — comportement fonctionnel garanti identique (CSS pur).
- **Aucune nouvelle dépendance** (`package.json` inchangé).

## Vérification finale

- **Typecheck** : `npx tsc --noEmit` — OK, aucune erreur.
- **Build** : `npm run build` — OK, 1.34s, précache 16 entrées (1781.17 KiB, taille identique — CSS déjà compté dans le build précédent).
- **DB réelle** : taille et date de modification identiques avant/après (19 542 016 octets, 16/09/2026 01:44) — jamais touchée.

---

## GATE PHASE 5

```
PHASE 5 — DROPDOWNS : PASS

Professeur :
PASS

Autres selects corrigés :
Générateur d'images (3 selects, aucun style préexistant), Agents externes (5 selects),
Settings → Modèles (modèle puissant + conversation + fallback), et par construction
(règle CSS globale) l'ensemble des ~25 <select> des 13 fichiers de l'app.

Fond blanc indésirable restant :
0 attendu — confirmé 0 (getComputedStyle sur option dans 5 zones distinctes,
toutes rgb(10,8,20) ou rgb(15,11,30), jamais blanc)

Comportement fonctionnel modifié :
NON — confirmé (changement CSS uniquement, aucune ligne de JSX/logique modifiée,
sélection testée et fonctionnelle dans toutes les zones)

Typecheck :
PASS

Build :
PASS

Test navigateur réel :
PASS (Playwright, backend isolé sur DB jetable, 0 erreur console/page)
```
