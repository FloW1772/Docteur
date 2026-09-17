# Batch A — Robustesse rapide (2026-09-16)

Autorisé explicitement par l'utilisateur, avec contraintes strictes (pas de credentials
réels, tests isolés uniquement, préservation totale du comportement OpenRouter validé).

## Findings traités (issus de `reports/DOCTEUR_MASTER_AUDIT_2026-09.md`)

### F16 — Crash 500 sur `limit`/`offset` non numérique

Nouveau : `cortex-server/src/lib/http-params.js` — `parseIntParam(rawValue, fallback)`,
utilise `Number.isFinite()` pour ne jamais laisser un `NaN` atteindre une requête SQLite
préparée.

Appliqué dans 5 fichiers :
- `routes/memory.js`, `routes/notebook.js` (introduits par cette mission)
- `routes/privacy.js`, `routes/skills.js`, `routes/teacher.js` (préexistants)

`routes/teacher.js` : seule la ligne `GET /teacher/review/due` (révision espacée) a été
modifiée — aucune ligne du fallback OpenRouter (lignes 232-261, logique historiquement
corrigée) n'a été touchée. Vérifié par diff ligne à ligne.

### F17 — Messages d'erreur OAuth bruts renvoyés au client

`routes/connectors.js` : nouvelle fonction `sanitizeProviderError(provider)` — message
générique fixe renvoyé au client (`"Échec de la communication avec X — voir les journaux
serveur pour le détail."`), le détail réel reste dans les logs (`logger.warn`, déjà en
place, inchangé) et dans `recordConnectorSyncResult` (stockage local uniquement). Appliqué
aux 2 points identifiés (callback OAuth, synchronisation).

### F1 — Absence de timeout sur les appels fetch() des connecteurs

`lib/connectors/youtube-connector.js` (3 appels) et `lib/connectors/onedrive-connector.js`
(4 appels) : chaque `fetch()` porte désormais `signal: AbortSignal.timeout(...)` —
15s pour les échanges OAuth/API JSON, 60s pour le téléchargement de fichier (corps plus
volumineux, timeout distinct et documenté). Pattern aligné sur celui déjà utilisé dans
`lib/providers/comfyui.js`.

## Vérifications

| Vérification | Résultat |
|---|---|
| Tests ciblés (`test-batch-a-robustness.mjs`, nouveau) | ✅ 12/12 |
| `test-openrouter-regression.mjs` (préservé, non modifié) | ✅ 27/27 (avec test-teacher-fallback.mjs) |
| `test-teacher-fallback.mjs` (préservé, non modifié) | ✅ inclus ci-dessus |
| Suite complète cumulée (Phases 0-10 + OpenRouter + Batch A) | ✅ 271/271 |
| TypeScript (`tsc --noEmit`) | ✅ 0 erreur |
| Build (`tsc && vite build`) | ✅ |
| `shell:true` dans les fichiers touchés | ✅ 0 occurrence |
| Fichier `openrouter.js` modifié | ✅ NON (0 changement, confirmé par diff) |
| Lignes du fallback OpenRouter dans `teacher.js` modifiées | ✅ NON (seule la ligne `review/due`, sans rapport, a changé) |
| Appel réseau réel pendant les tests | ✅ 0 (fetch systématiquement mocké) |
| Base de données réelle touchée | ✅ NON — horodatage `cortex.sqlite` inchangé avant/après (23:52) |
| Credential réel modifié | ✅ NON |
| Donnée utilisateur supprimée | ✅ 0 |

## Résultat

**BATCH A : PASS**

Aucune régression détectée. Diff isolé et minimal (3 fichiers préexistants modifiés de
façon ciblée, 1 nouveau fichier utilitaire, 2 connecteurs enrichis d'un timeout, 1 nouveau
fichier de test). La suite de non-régression OpenRouter (27 tests) et le comportement de
fallback validé restent intacts et vérifiés inchangés.

**J'attends votre autorisation explicite avant de lancer le Batch B.**
