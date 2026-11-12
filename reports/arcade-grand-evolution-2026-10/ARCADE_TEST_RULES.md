# Règles de test Arcade (depuis le BSOD du 22/10/2026)

**Toute commande de test doit être courte, vérifiable, non récursive et supervisée.**

1. Lancer `node` directement, avec des arguments explicites. Pas de shell intermédiaire, pas de fonction ou d'alias
   shell personnalisé, et jamais de fonction portant le nom d'une commande système (`tr`, `grep`, `cut`, `node`…).
2. Pas de pipeline complexe, en particulier un pipeline qui masquerait le code de sortie de la commande principale.
3. Rien en arrière-plan, rien de détaché, pas de boucle de lancement, pas de relance automatique après un échec.
4. Une seule exécution à la fois. Une seconde commande lourde n'est lancée qu'après la fin **confirmée** de la
   précédente.
5. Calculs Filament : uniquement par `node scripts/filament-safe-run.mjs <script approuvé>`.
   - Les scripts approuvés sont inscrits dans `APPROVED_SCRIPTS`, qui ne contient actuellement que
     `scripts/test-filament-lab-guards.mjs`.
   - Ajouter un script est une modification de code soumise à revue.
   - Pas de grille complète à plusieurs actions : rejeu de solutions connues, puis recherche locale bornée.
6. Navigateur et rendu 3D : interdits sans autorisation explicite. Liste d'exclusion actuelle :

   | Script | Options de rendu forcées |
   |---|---|
   | `scripts/measure-synapse-run-perf.mjs` | `--enable-gpu --ignore-gpu-blocklist --use-angle=d3d11` (et swiftshader) |
   | `scripts/test-synapse-run-evolution-browser.mjs` | `--enable-gpu --ignore-gpu-blocklist --use-angle=d3d11` |
   | `scripts/test-synapse-run-polish-browser.mjs` | `--enable-gpu --ignore-gpu-blocklist --use-angle=d3d11` (et swiftshader) |
   | `scripts/test-arcade-browser.mjs` | `--use-angle=swiftshader` (WebGL logiciel, charge processeur) |
   | `scripts/test-arcade-production.mjs` | `--use-angle=swiftshader` |
   | `scripts/test-arcade-saves-browser.mjs` | `--use-angle=swiftshader` |
   | `scripts/test-final-review-browser.mjs` | `--use-angle=swiftshader` |
   | `scripts/test-final-review-production.mjs` | `--use-angle=swiftshader` |
   | `scripts/test-synapse-run-browser.mjs` | `--use-angle=swiftshader` |
   | `scripts/test-synapse-run-progression-browser.mjs` | `--use-angle=swiftshader` |
   | `scripts/capture-synapse-run-visual.mjs` | Aucune par défaut ; GPU forcé seulement avec `--allow-gpu-flags` |

7. Une règle écrite (y compris dans la mémoire de l'agent) n'est pas un contrôle technique. Seuls le lanceur et les
   budgets du laboratoire imposent des limites, et seulement aux outils qui passent par eux.
