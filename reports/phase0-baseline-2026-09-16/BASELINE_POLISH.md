# BASELINE POLISH — Phase 0 (lecture seule)

Date : 2026-09-16
Mode : lecture seule, aucune correction appliquée.

## Git status au départ

Working tree avec un volume important de travail non committé (déjà présent avant cette mission — voir mémoire projet) :
- 21 fichiers modifiés (non stagés) : `README.md`, plusieurs libs/routes `cortex-server/src/`, `src/App.tsx`, `TopBar.tsx`, `SettingsModal.tsx`, `FreeAiFinder.tsx`, `src/lib/cortex/client.ts`, `test-maintenance.mjs`, `test-privacy-guard.mjs`.
- ~40 fichiers/dossiers untracked : nouveaux modules (`browser.js`, `chunking.js`, `connector-registry.js`, `connectors/`, `http-params.js`, `memory.js`, `notebook*.js`, `pkce.js`, `sherlock.js`, `source-privacy.js`), nouvelles routes (`browser.js`, `connectors.js`, `memory.js`, `notebook.js`, `notebooklm.js`, `sherlock.js`), 9 nouveaux fichiers de test (`test-batch-a/b/c/d`, `test-openrouter-regression`, `test-phase1..7`), le dossier `reports/` complet (contenant les certifications précédentes), 2 scripts (`scripts/test-connectors-*.mjs`), et plusieurs composants frontend (`NotebookModal.tsx`, `BrowserSettingsSection.tsx`, `MemorySettingsTab.tsx`, `NotebookLmSettingsSection.tsx`, `SherlockSettingsSection.tsx`).

Rien n'a été modifié, stashé, committé ou nettoyé pendant cette phase.

## Tests

Méthodologie confirmée identique à la certification précédente (`DOCTEUR_FINAL_CERTIFICATION_2026-09.md`) : chaque fichier `test-*.mjs` réel (`node:test`) exécuté dans son propre process (`node --test <fichier>`), car `sqlite.js` expose un singleton DB au niveau module.

Fichiers exclus (scripts manuels/interactifs, pas des suites `node:test`), inchangé depuis la dernière certification :
- `test-find-eval.mjs`
- `test-regression-api.mjs`
- `test-video-manual.mjs`

**36 fichiers de suite réelle** exécutés individuellement (liste complète dans `run.log`).

Note méthodologique : `test-video-pipeline.mjs` nécessite le flag `--experimental-test-module-mocks` (utilise `mock.module`, déjà documenté dans `package.json` → `test:video`). Une première passe sans ce flag a produit un faux échec (`TypeError: mock.module is not a function`) ; corrigé en relançant ce fichier avec le flag requis. Résultat confirmé : 2/2 PASS. Aucun autre fichier ne requiert de flag spécial.

### Résultat

- **Tests exécutés : 530**
- **PASS : 530**
- **FAIL : 0**
- **SKIP : 0**

Détail par fichier (tests/pass/fail) :

| Fichier | Tests | Pass | Fail |
|---|---|---|---|
| test-agent-neuron-lifecycle.mjs | 1 | 1 | 0 |
| test-ai-provider-fallback.mjs | 54 | 54 | 0 |
| test-ai-providers.mjs | 37 | 37 | 0 |
| test-batch-a-robustness.mjs | 12 | 12 | 0 |
| test-batch-b-notebook-performance.mjs | 5 | 5 | 0 |
| test-batch-b-request-logs.mjs | 12 | 12 | 0 |
| test-batch-c-onedrive-size-limit.mjs | 12 | 12 | 0 |
| test-batch-d-connectors.mjs | 33 | 33 | 0 |
| test-checkytdlp-handling.mjs | 3 | 3 | 0 |
| test-cli-shell-resolution.mjs | 15 | 15 | 0 |
| test-comfyui-install-manager.mjs | 35 | 35 | 0 |
| test-external-agents.mjs | 29 | 29 | 0 |
| test-files-xlsx.mjs | 7 | 7 | 0 |
| test-free-ai-catalog.mjs | 22 | 22 | 0 |
| test-free-ai-routes.mjs | 12 | 12 | 0 |
| test-freellmapi.mjs | 7 | 7 | 0 |
| test-image-generation.mjs | 22 | 22 | 0 |
| test-jobs-route.mjs | 5 | 5 | 0 |
| test-maintenance.mjs | 1 | 1 | 0 |
| test-neurons-all-meta.mjs | 2 | 2 | 0 |
| test-openrouter-regression.mjs | 16 | 16 | 0 |
| test-phase1-egress-certification.mjs | 7 | 7 | 0 |
| test-phase2-connectors.mjs | 12 | 12 | 0 |
| test-phase3-adaptive-memory.mjs | 26 | 26 | 0 |
| test-phase4-free-ai-images.mjs | 6 | 6 | 0 |
| test-phase5-notebook.mjs | 17 | 17 | 0 |
| test-phase5b-notebooklm.mjs | 8 | 8 | 0 |
| test-phase6-browser.mjs | 16 | 16 | 0 |
| test-phase7-sherlock.mjs | 18 | 18 | 0 |
| test-privacy-guard.mjs | 33 | 33 | 0 |
| test-prompt-templates.mjs | 11 | 11 | 0 |
| test-router-providers-perf.mjs | 1 | 1 | 0 |
| test-strict-local-centralized.mjs | 6 | 6 | 0 |
| test-teacher-fallback.mjs | 11 | 11 | 0 |
| test-video-audio.mjs | 14 | 14 | 0 |
| test-video-pipeline.mjs | 2 | 2 | 0 |

### Point notable : `test-maintenance.mjs`

La certification précédente (510/511) documentait un échec préexistant déterministe sur ce fichier (FINAL-F1), avec une recommandation de fix non appliquée à l'époque. Dans l'état actuel du working tree (non committé), ce fichier a été modifié :
- Le correctif recommandé (b) a été appliqué : `setRouterSettings({ chat_model: 'dedicated:latest' })` est maintenant appelé avant l'assertion qui échouait.
- Le mécanisme qui lisait les **vraies clés cloud** de `cortex.sqlite` via un process enfant (`execFileSync`) a été **supprimé** et remplacé par des valeurs sentinelles fictives (`fake-maintenance-gemini`, `fake-maintenance-groq`, `fake-maintenance-openrouter`) — amélioration d'isolation directement pertinente pour la Phase 1.
- Import ajouté de `test-setup.mjs`.

Résultat : **1/1 PASS**, plus aucune dépendance à la vraie base. Ceci n'est pas une régression — c'est le fix déjà recommandé par la certification précédente, apparemment appliqué depuis (travail non committé, cohérent avec la mémoire projet indiquant des phases de travail en cours).

## Typecheck

- `cortex-server` : `npx tsc --noEmit` → **OK**, aucune erreur.
- Frontend (racine) : `npx tsc --noEmit` → **OK**, aucune erreur.

## Build

`npm run build` → **OK**, succès en 28.72s.
- Bundle éager principal : `index-z8uHuvui.js` = 1 393,38 kB (identique à la mesure de la certification précédente).
- Chunks lazy présents : `SettingsModal` (180,10 kB), `NotebookModal` (15,47 kB), `ImageGeneratorModal` (8,78 kB).
- PWA : `generateSW`, precache 16 entrées (1 769,92 KiB), `dist/sw.js` + `dist/workbox-c121765f.js` générés.
- Aucune erreur, aucun asset manquant signalé.

## Conclusion Phase 0

```
BASELINE POLISH

Tests :
530/530 PASS (36 fichiers), 0 FAIL, 0 SKIP

Typecheck :
OK (cortex-server + frontend)

Build :
OK (28.72s, PWA precache généré)
```

Aucune correction n'a été appliquée pendant cette phase. Prêt à passer en Phase 1 (isolation des credentials) sous réserve de votre approbation.
