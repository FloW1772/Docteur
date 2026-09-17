# Vérification de non-régression OpenRouter (2026-09-15)

Demande utilisateur : retrouver le bug OpenRouter déjà rencontré, vérifier que le correctif
tient toujours, ajouter un test de non-régression dédié, et confirmer l'absence de tout
impact sur les credentials réels.

## 1. Cause retrouvée

Documentée dans `MAINTENANCE-2026-09-08.md` (section « Professeur ») :

- **Restriction de modèle** : OpenRouter doit rester limité au modèle gratuit fixe
  `nvidia/nemotron-3-super-120b-a12b:free` — tout autre identifiant doit être refusé à la
  validation (protection anti-facturation, ce modèle est le seul dont OpenRouter garantit
  la gratuité).
- **Bug observé en direct** : un test réel a produit `HTTP 503 : réponse vide du
  fournisseur` sur une réponse longue. Le correctif exige que ce cas soit signalé
  explicitement (repli local unique et transparent), jamais un changement silencieux de
  modèle ni un rebond vers un autre provider cloud.

## 2. État du correctif — vérifié toujours présent

- `cortex-server/src/lib/providers/openrouter.js` :
  - `FREE_MODEL` câblé en dur (ligne 11), `assertFreeModel()` bloque tout modèle sans
    suffixe `:free` avant chaque requête (lignes 17-24).
  - Une réponse à contenu vide lève explicitement `OpenRouter: réponse vide`
    (`ErrorCategory.UNKNOWN`, ligne 78) — jamais un texte vide silencieux.
  - `guardCloudCall` présent en tête de `complete()` (verrou de confidentialité, Phase 1
    de la mission MASTER, vérifié indépendamment).
- `cortex-server/src/routes/teacher.js` (lignes 232-261) :
  - `RETRY_LOCAL_CATEGORIES` (UNKNOWN, PROVIDER_UNAVAILABLE, TIMEOUT, NETWORK_ERROR)
    déclenche un repli **local uniquement** (`callLocalTeacherModel`), jamais un autre
    provider cloud.
  - AUTH_FAILED et QUOTA_EXCEEDED sont explicitement exclus du repli — remontés à
    l'utilisateur pour action, jamais masqués par une réponse locale.
  - Les messages d'erreur exposés au frontend passent par un vocabulaire fixe et sanitisé
    (`FALLBACK_REASON_LABELS`/`OPERATION_ERROR_LABELS`) — jamais le texte brut du
    fournisseur (URLs internes, fragments de token, stack traces).
- `cortex-server/src/routes/router.js` : `nvidia/nemotron-3-super-120b-a12b:free` toujours
  la valeur pour `openrouter` dans la table de modèles par défaut.

**Conclusion : le correctif est intact, aucune régression détectée dans le code actuel.**

## 3. Test de non-régression dédié — ajouté

`cortex-server/test-openrouter-regression.mjs` (nouveau, 16 tests, tous PASS) — consolide
explicitement chaque point demandé, en plus de la couverture déjà existante dans
`test-teacher-fallback.mjs` (11 tests, déjà PASS avant cette vérification, non modifié) et
`test-phase1-egress-certification.mjs` (couverture générique 8 providers, dont OpenRouter) :

| # | Point demandé | Test(s) couvrant ce point |
|---|---|---|
| 1-2 | Cause + correctif retrouvés et vérifiés présents | REGRESSION 1, 2 |
| 3 | Test de non-régression dédié | Fichier entier + REGRESSION 3, 3b |
| 4 | Sélection du modèle | REGRESSION 4a |
| 4 | Authentification | REGRESSION 4b, 4b-bis |
| 4 | Erreurs (quota, indisponibilité) | REGRESSION 4c, 4c-bis |
| 4 | Fallback | REGRESSION 3b, 6, 6b |
| 4 | Privacy/egress lock | REGRESSION 5, 5b, 5c |
| 5 | Aucune donnée local_only vers OpenRouter | REGRESSION 5, 5b, 5c |
| 6 | Échec OpenRouter ≠ fallback cloud interdit | REGRESSION 6, 6b (vérifie explicitement qu'une clé Gemini configurée en parallèle n'est jamais appelée) |
| 7 | Jamais de vraie clé dans les tests | Garde-fou explicite en tête de fichier + REGRESSION 7/8 |
| 8 | Jamais d'écrasement des credentials réels | `initSqlite(':memory:')` exclusivement — voir section 4 |

## 4. Confirmation — aucune donnée réelle touchée

- Toute la suite (nouvelle + existante) tourne sur `initSqlite(':memory:')` — jamais le
  fichier réel `cortex-server/data/cortex.sqlite`.
- `globalThis.fetch` systématiquement mocké — un appel réseau non prévu lève une exception
  explicite (`UNEXPECTED_REAL_NETWORK_CALL`) plutôt que de silencieusement réussir.
- Vérifié après coup par une lecture seule (`GET /api/router/cloud-keys` sur le vrai
  serveur) : la clé OpenRouter réelle est intacte (masquée, inchangée). Aucune écriture
  n'a eu lieu sur la vraie base pendant toute cette vérification — horodatage du fichier
  `cortex.sqlite` inchangé avant/après.
- Rappel : la clé Groq reste celle régénérée après l'incident de la Phase 4 (mission
  précédente) — toujours en attente de ta propre régénération si ce n'est pas encore fait.

## 5. Résultat

```
node --test test-openrouter-regression.mjs test-teacher-fallback.mjs
→ 27/27 PASS (16 nouveaux + 11 existants)

node --test <suite complète cumulée Phases 0-10 + OpenRouter>
→ 259/259 PASS
```

## OPENROUTER REGRESSION : PASS

**Credential réel modifié : NON**
**Appel cloud live : 0**
**local_only envoyé OpenRouter : 0**
