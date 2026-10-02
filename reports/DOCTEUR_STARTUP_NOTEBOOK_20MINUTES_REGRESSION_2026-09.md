# DOCTEUR — Startup + Notebook regression causality + 20 Minutes extraction robustness

Date de certification : 2026-09-30  
Portée : NB-1 à NB-6, démarrage PC, Deep Capture article, pipeline save/index, non-régressions globales.  
Verdict : **PASS**.

## 1. Méthode et règle de preuve

Les conclusions ci-dessous sont fondées sur le code, des tests contrôlés ou des mesures. Elles ne reposent pas sur la seule proximité temporelle. Notebook n'a pas été désactivé, reverté ou affaibli. Les modules gelés OMEGA, RASSILON, DEVICE FABRIC, MAITRE et OBSERVATEUR n'ont pas été modifiés.

Le checkpoint de causalité NB-1–NB-6 a été établi avant le correctif 20 Minutes. Il concluait déjà que Notebook n'était la cause ni du changement de consoles, ni de l'extraction partielle, ni de l'ancien timeout article. Le test de contention contrôlé réalisé ensuite a aussi écarté une contention Ollama/LanceDB reproductible.

## 2. Carte d'impact NB-1 à NB-6

| Phase | Fichiers ou groupes concernés | Partagé avec d'autres fonctions | Impact startup possible | Impact capture/réseau possible | Impact DB/LanceDB/UI | Risque constaté |
|---|---|---:|---:|---:|---:|---|
| NB-1 | Rapport d'architecture uniquement | Non | Non | Non | Aucun code | Nul |
| NB-2 | `notebook-documents*.js`, parsers, chunker, security, retrieval, route documents, tests; ajouts ciblés à `notebook-docs-store.js`, `notebook-documents-runtime.js`, `routes/notebook.js`, `server.js`, `lancedb.js`, `NotebookModal.tsx`, `client.ts` | Oui, glue serveur/client et même DB | Migration additive au boot | Strict Local limité au flux Notebook; aucun wrapper fetch global | Tables SQLite/FTS et table LanceDB `notebook_chunks`; panneau Documents | Faible, testé |
| NB-3 | Retrieval/conflits/rétention, calibration/benchmarks; retrait Google Fonts dans `index.html`, `globals.css`, `vite.config.ts` | Oui, assets frontend et LanceDB | Sweep borné au boot | Aucun changement de Deep Capture, Playwright, `global.fetch`, undici ou axios | Recherche hybride Notebook explicite | Faible, testé |
| NB-4 | `notebook-ai-*`, route AI history, panneau UI, extensions store/runtime, `server.js`, `client.ts` | Oui, glue serveur/client | Migration additive et récupération ciblée | Import local explicite; aucun intercepteur réseau global | Réutilise `notebook_chunks` avec provenance AI | Faible, testé |
| NB-5 | `notebook-memory*.js`, route Memory, panneau UI, extensions `lancedb.js`, store/runtime, `server.js`, `client.ts` | Oui, DB/LanceDB et glue | Migration additive, purge session bornée | Strict Local et endpoints Memory uniquement | Tables `dmem_*`, FTS et table LanceDB `docteur_memory` | Faible, testé |
| NB-6 | Durcissement `notebook-memory.js` et `routes/notebook-memory.js`, tests de certification | Route Memory seulement | Non | Guard Host/Origin/JSON et 64 KiB limité à `/api/docteur-memory/*` | Aucun changement de schéma ou de LanceDB | Faible, 12/12 |

Note de périmètre : NB-7 existe dans le worktree et introduit ultérieurement un garde central pour les routes non gelées. Ce travail est distinct de NB-1–NB-6. Son plafond par défaut vaut 64 MiB, pas 64 KiB; les uploads déclarés valent 2 GiB et chat/search 1 MiB. Il ne constitue donc pas une fuite du plafond NB-6.

## 3. Fichiers partagés et middleware

Fichiers partagés audités : `src/App.tsx`, `src/hooks/useCortex.ts`, `src/hooks/usePages.ts`, `src/lib/cortex/client.ts`, `cortex-server/src/server.js`, `cortex-server/src/lib/lancedb.js`, `cortex-server/src/routes/notebook.js`, `index.html`, `vite.config.ts`, `package.json`, scripts `.bat`/`.ps1` et routes capture/index/neuron/video.

Résultats :

- aucun changement NB-1–NB-6 de `global.fetch`, undici, axios, AbortController global, timeout HTTP commun, lifecycle Chromium, interception Playwright, user-agent ou blocage de ressources;
- l'ancien timeout frontend à 90 secondes n'a pas été introduit par Notebook;
- NB-6 monte son garde uniquement sur `/api/docteur-memory/*`; il accepte les clients backend légitimes sans Origin, exige un Host local et valide l'Origin navigateur;
- aucun plafond NB-6 à 64 KiB ne touche `/api/capture`, `/api/capture/deep`, `/api/index`, `/api/neuron` ou la vidéo;
- sous la politique NB-7 distincte, capture/index/neuron utilisent le plafond par défaut de 64 MiB et `/api/video-summary` le plafond upload de 2 GiB;
- la matrice NB-7 inventorie 627 routes; les tests Host, Origin, DNS rebinding, JSON-only, CORS, plafonds et exemptions gelées passent;
- la correction article reste locale à Deep Capture, à la propagation de ses diagnostics et à l'affichage de son état. Aucun nouveau middleware global n'a été ajouté.

## 4. SQLite, migrations et démarrage

Les migrations Notebook sont additives et idempotentes. Elles utilisent les statements préparés du même processus, sans modification globale de WAL, foreign keys ou busy timeout observée dans NB-1–NB-6. Aucun lock durable ni changement d'ordre destructif n'a été reproduit.

Mesure fraîche, cinq exécutions :

| Étape | Temps observé |
|---|---:|
| Chargement module SQLite | 23–27 ms |
| Initialisation DB core | 14 ms |
| Migration Memory | 2 ms |
| Migrations Notebook documents/AI/Memory idempotentes | 13 ms |
| Total instrumenté | 52–56 ms |

Le processus Cortex actif a atteint l'écoute en environ 4,2 s. Le cold boot isolé du pipeline réel a pris 3 114 ms. Les coûts Notebook mesurés ne constituent pas un goulot de démarrage.

## 5. LanceDB, embeddings et Ollama

LanceDB utilise une connexion partagée mais des tables séparées : `neurons` pour l'historique, `notebook_chunks` pour Notebook et `docteur_memory` pour Memory. Les écritures sont déclenchées par import/reindex explicite; aucun scan ou embedding Notebook continu ne démarre en arrière-plan. Au boot, seules des récupérations/purges bornées sont possibles.

Test contrôlé :

| Situation | Article embedding | LanceDB | Latence index article | Travail Notebook |
|---|---:|---:|---:|---:|
| Notebook idle | 121 ms | 21 ms | 167 ms | 0 |
| Import Notebook concurrent | 76 ms | 21 ms | 112 ms | 48 chunks en 1 297 ms |

Aucune contention article n'a été reproduite. L'ancien cas de 32 263 ms concernait l'embedding article après une analyse Qwen; LanceDB ne prenait que 41 ms. Les logs de cette fenêtre ne montrent aucune activité Notebook. La variation est cohérente avec le chargement/changement de modèle Ollama, mais Notebook n'en est pas la cause démontrée.

## 6. Causalité

| Incident | Relation Notebook | Preuve |
|---|---|---|
| 4 → 2 consoles visibles | **DISPROVEN** | NB-1–NB-6 ne changent aucun launcher. `Docteur-Launcher.bat` ouvre Cortex et Frontend, n'ouvre Ollama que s'il n'existe pas déjà, puis le lanceur se ferme. Les services auxiliaires vivent dans Cortex. |
| 20 Minutes, extraction partielle | **DISPROVEN** | Le HTML réel de l'article B fournit 1 203 caractères/193 mots par Readability. L'ancien seuil fixe de 200 mots le rejetait, puis le même seuil rejetait le rendu Playwright. Aucun code Notebook n'est dans cette chaîne. |
| Embedding lent | **DISPROVEN pour NB-1–NB-6** | Zéro activité Notebook dans la fenêtre et test concurrent sans ralentissement. Le coût LanceDB était négligeable. |
| Capture → save → index | **DISPROVEN** | Pipeline réel isolé A et B complet jusqu'à `READY`; tables Notebook séparées; tests save/index et états d'échec passent. |

## 7. Architecture de démarrage et processus

`Docteur-Launcher.bat`, mode PC :

| Composant | Processus attendu | Exécutable/commande | Port | Console attendue | État certifié |
|---|---|---|---:|---|---|
| Lanceur | CMD transitoire | `Docteur-Launcher.bat` | — | Oui, puis fermeture | Conforme |
| Ollama | Serveur Ollama, plus runners de modèles à la demande | `ollama serve` | 11434 | Seulement si le launcher doit le démarrer; peut déjà être en arrière-plan | 1 listener, PID 8776 |
| Cortex | Node via npm/nodemon | `node src/server.js` | 3001 | Oui | 1 listener, PID 30168 |
| Frontend | Vite | `vite --host 127.0.0.1 --port 5173` | 5173 | Oui | 1 listener, PID 15492 |
| Scheduler, inbox watcher, Observateur monitor | Services internes Cortex | même processus Node | — | Non | Actifs d'après le boot/log |

L'arbre réel contient un unique listener attendu sur chacun des ports 3001, 5173 et 11434. Les deux processus `ollama runner` enfants sont des runners de modèles, pas des doubles serveurs. `/api/health` retourne `status=ok`, `ollama_connected=true`, les modèles configurés et le PID Cortex 30168.

Cause du passage apparent de quatre à deux fenêtres : le launcher est transitoire et Ollama déjà actif peut être réutilisé/en arrière-plan; seules les fenêtres durables Cortex et Frontend restent visibles. Aucun service requis ne manque et aucun changement artificiel de fenêtres n'est justifié.

## 8. Cause racine 20 Minutes

Cause exacte : l'ancien code utilisait `MIN_WORDS_FAST = 200` comme seuil de complétude. L'article B réel contient un corps valide d'environ 193 mots : Readability le récupérait, mais le seuil le rejetait. Le fallback Playwright appliquait le même critère, puis la capture simple persistait environ 180 caractères de métadonnées en donnant une impression de succès.

Correction minimale et générique :

- collecte et score des candidats Readability, JSON-LD `Article`/`NewsArticle` (y compris `@graph`), DOM sémantique et DOM rendu;
- qualité fondée sur caractères, mots, paragraphes, sémantique article et ratio de boilerplate;
- attente Playwright d'un contenu utile plutôt qu'un délai fixe de trois secondes;
- validation avant l'appel Qwen;
- métriques détaillées : HTTP, URL finale, tailles raw/rendered, tailles par extracteur, choix, raison de fallback et durées navigation/wait/extraction;
- candidat incomplet conservé avec `PARTIAL_EXTRACTION`, avertissement et raison explicites, jamais faux `READY`;
- image principale et images valides fusionnées entre candidats; thumbnails/avatars minuscules restent filtrés par la chaîne existante;
- aucune branche spécifique à `20minutes.fr`.

## 9. Comparaison réelle Article A / Article B après correction

| Mesure | Article A | Article B |
|---|---:|---:|
| HTTP | 200 | 200 |
| HTML brut | 738 857 caractères | 646 489 caractères |
| Readability | 6 279 caractères / 964 mots | 1 203 caractères / 193 mots |
| JSON-LD structuré | 6 256 / 972 | 1 125 / 182 |
| DOM sémantique | 6 221 / 967 | 1 171 / 189 |
| Candidat final | 6 221 / 967, 13 paragraphes | 1 171 / 189, 5 paragraphes |
| Extracteur choisi | semantic-dom | semantic-dom |
| Images | 2 | 1 |
| Fallback Playwright requis | Non | Non |
| Qualité | COMPLETE | COMPLETE |

Pipeline réel isolé, vraie instance Ollama, SQLite/LanceDB temporaires :

| Étape | Article A | Article B |
|---|---:|---:|
| Capture totale | 22 282 ms | 10 820 ms |
| Fetch/extraction | 2 085 / 1 829 ms | 1 654 / 1 530 ms |
| Analyse AI | 18 641 ms | 8 595 ms |
| Titre | 314 ms | 488 ms |
| Save initial | 5 ms | 4 ms |
| Embedding | 1 089 ms | 28 ms |
| LanceDB | 24 ms | 22 ms |
| Index total | 1 126 ms | 58 ms |
| Save `READY` | 4 ms | 3 ms |
| État relu | READY | READY |

Deux lignes LanceDB ont été retrouvées. Les essais ont utilisé un répertoire temporaire, sans polluer les données utilisateur.

## 10. Preuves de régression

| Suite | Résultat |
|---|---:|
| NB-2 à NB-6 serveur, périmètre demandé | **162/162** |
| NB-2 à NB-7 serveur, run consolidé élargi | **199/199** |
| NB-6 certification sécurité seule | **12/12** |
| Browser Notebook NB-2/NB-3/NB-4/NB-5 | **158/158** |
| Article extraction/save/index/quality | **8/8** |
| Browser article | **21/21** |
| Autres sources/extracteurs : local générique, JSON-LD, MSN-like `@graph`, Wikipedia/Readability, Playwright rendu | **5/5** |
| Frontend vidéo | **10/10** |
| Serveur vidéo | **16/16** |
| YouTube Shorts discovery | **24/24** |
| Boot proof isolé | **42/42** |
| TypeScript | **PASS** |
| Build Vite/PWA | **PASS** |
| Syntaxe `deep-capture.js` et `server.js` | **PASS** |

Garanties explicitement couvertes : fuite de secret 0, fuite cross-notebook 0, fuite cross-project 0, exécution automatique d'outil 0, émission réseau Notebook 0, Strict Local préservé, sécurité Host/Origin/DNS rebinding préservée, un seul listener par service.

## 11. Fichiers changés pour cette mission

- `cortex-server/src/lib/deep-capture.js`
- `cortex-server/src/routes/capture.js`
- `cortex-server/src/server.js`
- `src/lib/cortex/client.ts`
- `src/App.tsx`
- `scripts/test-article-capture-pipeline.mjs`
- `scripts/test-article-capture-browser.mjs`
- `scripts/audit-queue-lib.mjs`
- `cortex-server/audit-20minutes-extraction.mjs`
- `cortex-server/audit-20minutes-full-pipeline.mjs`
- `cortex-server/audit-notebook-embedding-contention.mjs`
- `reports/DOCTEUR_STARTUP_NOTEBOOK_20MINUTES_REGRESSION_2026-09.md`

Les fichiers partagés contenaient déjà d'autres modifications non commitées; elles ont été préservées. Aucun `git add`, commit, push, reset, clean, stash, checkout ou restore destructif n'a été exécuté.

## 12. Limites connues

- Les pages éditeur peuvent changer de structure, ou servir ultérieurement un challenge anti-bot; le système exposera alors `PARTIAL_EXTRACTION` au lieu d'un faux succès.
- Les durées Qwen/Ollama dépendent du cache et des modèles résidents; les chiffres sont des mesures, pas un SLA.
- Le nombre exact de fenêtres visibles dépend de l'état préalable d'Ollama et de la fermeture du launcher; les listeners/arbres de processus sont la preuve fiable.
- NB-7, postérieur au périmètre demandé NB-1–NB-6, comporte un garde central intentionnel et documenté; il ne faut pas l'attribuer rétrospectivement à NB-6.

## 13. Conclusion

Notebook NB-1–NB-6 n'est pas responsable des incidents actuels. Le démarrage est complet et sans duplication. La cause racine de l'article B est démontrée et corrigée sans sélecteur propre à 20 Minutes, sans nouveau middleware global et sans affaiblir NB-6. Les deux URLs réelles passent Capture → save → index → READY avec leurs images et leurs diagnostics.
