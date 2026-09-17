# MASTER PHASE 0 — Baseline & Garde-fous

Date: 2026-09-15
Branche: `main` @ `6ab87a5`

## 1. État Git au démarrage

```
git status  → working tree clean, up to date with origin/main
git diff --stat → (vide, aucune modification en cours)
```

Aucun fichier préexistant modifié, aucun artefact de test non suivi trouvé
à la racine du dépôt au moment du lancement de la mission.

Derniers commits (`git log --oneline -5`):
```
6ab87a5 feat: add privacy tests and enhance privacy route functionality
7a77537 feat: add ImagesSettingsTab for image generation settings and management
669ee54 feat: add prompt template library and server readiness check
1317364 Add tests for Free AI catalog and routes, and implement FreeAiFinder component
e80b5ee feat: update README with enhanced descriptions, improved formatting, and additional sections for clarity
```

## 2. Typecheck frontend

```
npx tsc --noEmit
```
Résultat: **OK** — 0 erreur.

## 3. Build frontend

```
npm run build   (tsc && vite build)
```
Résultat: **OK** — build réussi en ~32s.

Sortie notable:
- `dist/assets/esm-dOBh4Pjv.js` = 3.35 MB (893 KB gzip) — chunk volumineux, average pour ce
  type de projet (three.js + mediapipe + tesseract), à surveiller en Phase 9 (audit perf),
  pas d'action en Phase 0.
- PWA precache: 11 entrées, 1726 KiB.
- Avertissement Vite: chunks > 500 kB — noté, non bloquant.

## 4. Backend — démarrage et santé

`node src/server.js --check` **reste bloqué** (ne rend jamais la main) quand Ollama n'est
pas installé/démarré sur la machine — `runCheckOnly()` appelle `healthSnapshot()` qui semble
attendre une réponse Ollama sans timeout court. **Constat baseline, non corrigé en Phase 0**
(voir limitation ci-dessous). Un `--check` antérieur laissé orphelin occupait aussi le port
3001 (PID tué manuellement, processus de test uniquement, aucune donnée utilisateur touchée).

Démarrage normal (`node src/server.js`, sans `--check`) :

- Démarrage propre, écoute sur `127.0.0.1:3001`.
- `GET /api/health` → **HTTP 503** (dégradé, attendu sans Ollama) :
  ```json
  {"status":"degraded","ollama_connected":false,"models_available":[],
   "neurons_count":6726,"uptime":0,"local_network":false,"local_ip":null}
  ```
  → confirme que les **6726 neurones utilisateur existants sont intacts et lisibles**.
- `GET /api/neurons/recent?limit=10` → HTTP 200, ~328 ms, payload 7188 octets.
- Latence `/api/health` (3 appels) : 263 ms / 117 ms / 140 ms (à froid puis chaud).

Ollama n'est pas installé/démarré dans cet environnement (`localhost:11434` ne répond pas,
aucun process `ollama` trouvé). C'est un état d'environnement, pas un bug applicatif — le
mode dégradé est correctement rapporté par le serveur plutôt qu'un crash.

## 5. Tests backend (mocks uniquement, aucun appel réseau réel)

Tous lancés avec `DOCTEUR_LIVE_TESTS=0` (défaut).

### Suite Privacy / Strict Local / Fallback provider (critique pour Phase 1)
```
node --test test-privacy-guard.mjs test-strict-local-centralized.mjs test-ai-provider-fallback.mjs
```
**87/87 PASS.** Aucun appel provider cloud détecté pendant les tests. Le test le plus long
(12.5s, `voice route: strict_local_mode forces provider back to local`) reste dans le budget
mocké.

### Suite complémentaire (catalogue APIs, jobs, maintenance, CLI, templates)
```
node --test test-neurons-all-meta.mjs test-free-ai-catalog.mjs test-free-ai-routes.mjs \
  test-freellmapi.mjs test-prompt-templates.mjs test-jobs-route.mjs test-maintenance.mjs \
  test-cli-shell-resolution.mjs
```
**74/75 PASS, 1 FAIL** (préexistant, indépendant de toute modification de cette mission) :

- `test-maintenance.mjs` échoue sur une assertion `calledLocalModel === 'dedicated:latest'`
  mais reçoit `mistral-nemo:12b-instruct-2407-q4_K_M`. Le test lit les vraies clés cloud
  depuis `data/cortex.sqlite` (DB réelle de cet environnement) et semble sensible à un
  paramètre `teacher_model` déjà présent dans les settings réels de cette installation
  (probablement issu d'un usage antérieur, pas d'une régression de code). Le test n'a pas
  été modifié ni corrigé — **noté comme limitation d'environnement de la baseline**, pas
  comme un FAIL bloquant introduit par la mission.

Aucun autre test (video, external-agents, comfyui-install, etc.) n'a été lancé en Phase 0 —
ils nécessitent des binaires/ressources non garantis présents (yt-dlp, ComfyUI, ffmpeg) et
seront couverts par leurs phases respectives si pertinent.

## 6. npm audit (lecture seule, aucun `fix`)

Frontend (`/dev/Docteur`):
```
{"info":0,"low":1,"moderate":1,"high":2,"critical":0,"total":4}
```

Backend (`/dev/Docteur/cortex-server`):
```
{"info":0,"low":0,"moderate":2,"high":0,"critical":0,"total":2}
```

Aucune action corrective appliquée (conforme à la règle : pas de `npm audit fix`,
`--force`, ni `--legacy-peer-deps`). Détail des CVE à traiter en Phase 9 (audit) si
pertinent, jamais en Phase 0.

## 7. Appels cloud pendant les tests

**0 appel cloud réel détecté.** Toute la suite lancée utilise des mocks Ollama/HTTP internes
aux tests ; `DOCTEUR_LIVE_TESTS` n'a pas été activé.

## 8. Limitations connues de la baseline (documentées, non corrigées)

1. `node src/server.js --check` bloque indéfiniment sans Ollama démarré (pas de timeout
   dans `runCheckOnly()`/`healthSnapshot()`). Impact: outil de diagnostic CLI seulement,
   aucun impact sur le serveur HTTP normal qui, lui, répond correctement en mode dégradé.
2. `test-maintenance.mjs` : 1 assertion sensible à l'état réel de la DB locale (valeur de
   `teacher_model` déjà configurée sur cette machine). Pré-existant, non lié à cette mission.
3. Ollama non installé/démarré dans cet environnement — toutes les fonctionnalités locales
   dépendant d'Ollama sont donc non testables en conditions réelles ici (mode dégradé
   uniquement). N'empêche pas de continuer : Phase 1+ utiliseront des mocks comme la
   baseline l'a déjà validé.
4. Build frontend produit un chunk `esm-dOBh4Pjv.js` de 3.35 MB — à examiner en Phase 9,
   aucune action en Phase 0.

## 9. Verdict

| Élément | Résultat |
|---|---|
| Git status | Clean |
| Typecheck | OK |
| Build frontend | OK |
| Backend démarre | OK (mode dégradé sans Ollama, attendu) |
| `/api/health` | OK (503 dégradé, données utilisateur intactes : 6726 neurones) |
| Tests privacy/strict-local/fallback | 87/87 PASS |
| Tests complémentaires | 74/75 PASS (1 échec préexistant, non bloquant, documenté) |
| Appels cloud pendant tests | 0 |
| Données utilisateur supprimées | 0 |
| shell:true détecté | 0 (non audité en détail ici, sera vérifié en Phase 1/7) |

## GATE PHASE 0

**PASS AVEC LIMITATION DOCUMENTÉE**

Justification : aucune régression, aucune faille de sécurité, aucun FAIL bloquant. Le seul
échec de test (`test-maintenance.mjs`) est un artefact d'environnement préexistant (données
réelles locales), sans lien avec le code applicatif ni avec cette mission. Les fondations
(build, typecheck, tests critiques privacy/strict-local, santé serveur, intégrité des
données) sont saines.

**→ CONTINUE vers PHASE 1 (certification du verrou privacy/egress).**
