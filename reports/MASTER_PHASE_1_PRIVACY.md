# MASTER PHASE 1 — Certification du verrou Privacy / Egress

Date: 2026-09-15
Branche: `main` (diff isolé, non commité)

## 1. Objectif

Prouver qu'une donnée privée/`local_only` ne peut atteindre AUCUN provider cloud, quel que
soit le point d'entrée (appel direct provider, chaîne de fallback, task facade `runAiTask`),
et distinguer un blocage "mode strict local" (`STRICT_LOCAL`) d'un blocage "contenu privé
détecté" (`PRIVATE_CONTEXT_CLOUD_BLOCKED`).

## 2. Architecture auditée

- `src/lib/privacy-guard.js` — sentinelle déterministe (`PRIVATE_SENTINEL`), `guardCloudCall()`
  appelée en tête de chaque `complete()`/`generate()` provider, `PrivacyViolationError`.
- `src/lib/strict-local.js` — verrou centralisé `strict_local_mode` pour les routes à appel
  cloud direct (research, teacher, voice).
- `src/lib/router.js` — verrou global dans `routedCompletion()` (INFRANCHISSABLE en mode
  strict) + `guardCloudCall` belt-and-suspenders dans chaque provider pour le mode neutre
  avec contenu privé marqué.
- `src/routes/privacy.js` — self-test synthétique (`POST /api/privacy/test`), journal
  d'incidents (`GET /api/privacy/violations`).
- UI `SettingsModal.tsx` (Paramètres → Confidentialité) — déjà conforme : tableau
  Provider/Donnée privée/Donnée neutre, message correct en cas d'échec synthétique
  ("Un échec ici signale que le verrou de sortie doit être corrigé, **pas qu'une fuite a eu
  lieu**") — aucune fausse alerte "FUITE DÉTECTÉE" trouvée dans le code. **Aucune
  modification UI nécessaire.**

## 3. Finding P0 — freellmapi.js n'appelait jamais guardCloudCall (CORRIGÉ)

**Preuve** : un probe synthétique (`markPrivate('CV confidentiel...')` envoyé à
`freellmapiProvider.complete()`) atteignait `fetch()` sans exception, contrairement à
gemini/groq/openrouter/openai/anthropic qui bloquent tous correctement.

**Fichier** : `cortex-server/src/lib/providers/freellmapi.js`
**Impact** : en mode neutre (strict_local_mode = OFF) avec FreeLLMAPI configuré, un contenu
marqué privé/local_only pouvait être envoyé à la gateway externe configurée par l'utilisateur.
**Cause** : ce provider a été ajouté après les autres et n'a pas reçu le même appel de garde
en tête de `complete()`.

**Correction appliquée** (1 ligne + 1 import, même pattern que gemini.js) :
```js
import { guardCloudCall } from '../privacy-guard.js';
...
export async function complete({ config, model, messages, ... }) {
  guardCloudCall({ messages, provider: 'freellmapi', functionCalled: 'complete' });
  ...
}
```

**Vérification** : probe re-exécuté après correction → `PrivacyViolationError` levée,
`fetch()` jamais appelé (`fetchCalled = false`).

## 4. Finding P1 — claude-oauth.js et codex.js n'appelaient jamais guardCloudCall (CORRIGÉ)

**Fichiers** : `cortex-server/src/lib/providers/claude-oauth.js`,
`cortex-server/src/lib/providers/codex.js`.

Ces deux providers (CLI Claude Code / Codex, via `spawn(..., { shell: false })`) sont listés
dans `router.js` `CLOUD_PROVIDER_IDS` mais leur `generate()` ne vérifiait jamais le contenu
avant de spawn le CLI. En production (hors `DOCTEUR_TEST_MODE`), rien n'empêchait un contenu
privé marqué d'être transmis au CLI Claude/Codex authentifié localement.

**Correction appliquée** : même pattern, `guardCloudCall({ messages, provider, functionCalled: 'generate' })`
ajouté juste après la déstructuration de `request`, avant toute résolution de commande CLI ou
tout `spawn()`.

**Note** : en environnement de test (`DOCTEUR_TEST_MODE=1`), un garde-fou préexistant
(`assertLiveCallAllowed()`) bloque déjà tout spawn réel avant même d'atteindre le nouveau
guard — comportement correct et non modifié, il donne une garantie zéro-spawn encore plus
stricte pendant les tests.

## 5. Correction du self-test route (`routes/privacy.js`)

La liste de providers testés par `POST /api/privacy/test` ne couvrait que
`['gemini', 'groq', 'openrouter', 'anthropic', 'openai']` — freellmapi, claude-oauth et codex
en étaient absents, malgré leur présence dans `CLOUD_PROVIDER_IDS` du router. Liste étendue à
8 providers. Le test existant `test-privacy-guard.mjs` avait une assertion figée sur
`results.length === 5` — mise à jour vers `8`. La liste `PROVIDERS` du fichier de test a été
alignée sur les 8 providers réels.

## 6. Nouveau fichier de tests dédié — `test-phase1-egress-certification.mjs`

Créé pour couvrir explicitement les exigences de la mission (marqueurs `__PRIVATE_TEST__` /
`__LOCAL_ONLY_TEST__`, matrice complète des providers, non-contournement du fallback,
distinction des raisons de blocage) de bout en bout via `router.js` (pas seulement au niveau
`guardCloudCall` isolé, déjà couvert par `test-privacy-guard.mjs`).

7 tests, tous PASS :
1. Matrice `CLOUD_PROVIDER_IDS` (8 providers) — chacun bloque `__PRIVATE_TEST__` avant tout
   fetch/spawn.
2. `tryCloudFallbackChain` — `__LOCAL_ONLY_TEST__` bloqué à CHAQUE candidat de la chaîne,
   jamais de fallback cloud→cloud pour un contenu privé.
3. Sanity check — contenu neutre atteint bien un cloud (le harnais ne bloque pas à outrance).
4. `runAiTask` avec `preferredProvider: 'gemini'` forcé — contenu privé jamais transmis à un
   cloud ; repli correct et sûr vers `local` (Ollama), pas une erreur — comportement voulu.
5. Distinction `STRICT_LOCAL` — bloque même le contenu neutre.
6. Distinction `PRIVATE_CONTEXT_CLOUD_BLOCKED` — bloque le contenu privé même avec
   `strict_local_mode = false`, et enregistre un incident réel (non simulé) dans le journal.
7. Fallback local (Ollama) reste autorisé pour du contenu privé — seul le cloud est bloqué.

### Découverte annexe — probe de catalogue FreeLLMAPI (non corrigée, documentée)

Pendant la construction du test #2, un appel réseau **sans contenu utilisateur**
(`GET {baseUrl}/v1/models`) a été observé : `router.js` `cloudCandidates()` interroge le
catalogue de modèles de la gateway FreeLLMAPI pour décider si elle doit figurer comme
candidat, **avant même de savoir si la requête en cours est privée**. Ce n'est pas une fuite
de contenu (aucun message, aucune donnée privée dans cet appel — juste une découverte de
capacités), et il est déjà correctement supprimé en `strict_local_mode = true` (le chemin
retourne avant `cloudCandidates()`). Mais en mode neutre avec FreeLLMAPI configuré, ce probe
réseau sort systématiquement, même pour une requête dont le contenu se révèlera privé.
**Non corrigé dans cette phase** (changement de portée plus large que ce Finding P0/P1 —
nécessiterait de réordonner `cloudCandidates()` pour recevoir le statut privé/local_only de
la requête avant de décider quels candidats construire). **Recommandation pour un futur
batch d'audit (Phase 9)** : passer un flag `isPrivateRequest` à `cloudCandidates()` pour
sauter entièrement la découverte de candidats cloud (y compris les probes de catalogue) dès
qu'une requête est marquée privée/local_only, pas seulement en `strict_local_mode`.

## 7. Résultats des tests

```
test-privacy-guard.mjs                    33/33  PASS
test-strict-local-centralized.mjs         (inclus dans le lot fallback ci-dessous)
test-ai-provider-fallback.mjs             (inclus)
test-freellmapi.mjs                       (inclus)
test-ai-providers.mjs                     (inclus)
test-cli-shell-resolution.mjs             (inclus)
test-router-providers-perf.mjs            (inclus)
test-phase1-egress-certification.mjs      7/7    PASS (nouveau)
```
Lot combiné (`test-privacy-guard.mjs test-strict-local-centralized.mjs
test-ai-provider-fallback.mjs test-freellmapi.mjs test-ai-providers.mjs
test-cli-shell-resolution.mjs test-router-providers-perf.mjs
test-phase1-egress-certification.mjs`) : **160/160 PASS**, 0 échec.

Tous les tests utilisent `DOCTEUR_TEST_MODE=1` / `DOCTEUR_LIVE_TESTS=0` (mocks fetch,
CLI spawn bloqué). **0 appel cloud réel.**

## 8. Typecheck / Build

- `npx tsc --noEmit` → OK (aucune modification frontend dans cette phase).
- `npm run build` → OK, build propre.

## 9. Fichiers modifiés (diff isolé, ciblé)

```
cortex-server/src/lib/providers/claude-oauth.js   +2
cortex-server/src/lib/providers/codex.js          +2
cortex-server/src/lib/providers/freellmapi.js     +2
cortex-server/src/routes/privacy.js               1 ligne changée (liste providers)
cortex-server/test-privacy-guard.mjs              2 lignes changées (liste + assertion)
cortex-server/test-phase1-egress-certification.mjs  nouveau fichier (7 tests)
```
Aucune donnée utilisateur touchée, aucun fichier de settings/DB réel modifié.

## 10. Vérification "0 appel cloud involontaire"

Confirmé par les tests automatisés (mocks fetch levant une exception si appelés avec du
contenu privé) et par les 2 probes manuels exécutés avant/après le correctif freellmapi.
Le seul appel réseau observé pendant toute la campagne de tests est le probe de catalogue
`/v1/models` documenté en section 6, sans contenu utilisateur.

## GATE PHASE 1

| Critère | Résultat |
|---|---|
| local_only → cloud calls | 0 (contenu jamais transmis) |
| fallback cloud→cloud pour contenu privé | 0 (bloqué à chaque candidat) |
| Distinction STRICT_LOCAL / PRIVATE_CONTEXT_CLOUD_BLOCKED | Confirmée par tests dédiés |
| UI "PROTECTION NON VALIDÉE" (pas "FUITE DÉTECTÉE") | Déjà conforme, vérifié |
| typecheck | OK |
| build | OK |
| Régression | 0 (160/160 tests passent après correctifs) |

**PASS** — 2 failles réelles trouvées (freellmapi, claude-oauth/codex) et corrigées avec un
correctif minimal et cohérent (même pattern que les providers déjà conformes). Une
observation mineure (probe de catalogue FreeLLMAPI) documentée pour un futur batch d'audit,
sans impact sur la garantie "zéro contenu privé transmis au cloud".

**→ CONTINUE vers PHASE 2 (connecteurs YouTube + Microsoft OneDrive).**
