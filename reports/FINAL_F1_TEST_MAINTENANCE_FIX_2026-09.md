# FINAL-F1 — Correction du test test-maintenance.mjs (2026-09-16)

Autorisation : correction du seul finding FINAL-F1, exclusivement dans le test. Aucun code de production modifié.

## FINAL-F1 : PASS

---

**Cause exacte** :

L'assertion en échec (`test-maintenance.mjs:52`, `assert.equal(calledLocalModel, 'dedicated:latest')`) partait d'une hypothèse incorrecte : que configurer le modèle Professeur via `POST /teacher/settings` (`model: 'dedicated:latest'`) déterminerait aussi le modèle réellement utilisé pour l'appel Ollama local.

En réalité, `callLocalTeacherModel` (`routes/teacher.js:166-171`) lit `getRouterSettings()?.chat_model` — un réglage **séparé et indépendant** du modèle Professeur. Le modèle Professeur ne sert qu'à déterminer le *provider* (local vs groq/gemini/openrouter) via `parseModelId()` ; une fois `provider === 'local'` établi, la chaîne de modèle Professeur elle-même est ignorée, et c'est `chat_model` qui pilote l'appel réel.

Sur une base `:memory:` fraîche (comme celle utilisée par ce test), `chat_model` vaut par défaut `'mistral-nemo:12b-instruct-2407-q4_K_M'` (`sqlite.js:983`) — exactement la valeur `actual` observée. **Reproductible à l'identique sans aucune donnée réelle** : confirmé pendant la certification précédente en interrogeant `getRouterSettings()` sur une DB `:memory:` vierge, sans lien avec `cortex.sqlite`.

**Code production modifié : NON — confirmé.** Le contrat réel du code (`chat_model` pilote l'appel local Professeur) est correct et n'a pas été changé. Seule l'hypothèse du test était fausse.

---

**Test rendu déterministe : OUI.**

Le test configurait déjà tout son état sur sa propre DB (`initSqlite(':memory:')`, ligne 24) — la seule lacune était de ne pas configurer explicitement `chat_model` avant l'assertion qui en dépend réellement. Correction (option A du mandat, préférée pour sa robustesse et son explicite) :

```js
setRouterSettings({ chat_model: 'dedicated:latest' });
assert.equal((await request('/teacher/paths', { subject: 'Fractions' })).status, 201);
assert.equal(calledLocalModel, 'dedicated:latest');
```

**Modèle configuré explicitement dans le test : `'dedicated:latest'`** (via `setRouterSettings({ chat_model: 'dedicated:latest' })`, sur la DB `:memory:` du test uniquement).

Le test ne dépend plus d'aucune valeur par défaut implicite pour cette assertion précise — il configure le réglage qui pilote réellement l'appel, puis vérifie que ce réglage est bien celui utilisé. L'assertion reste une égalité stricte (`assert.equal`), jamais affaiblie vers un `truthy`/`defined`/`includes` vague : elle continue de vérifier précisément que le bon setting pilote le bon appel modèle — c'est même désormais le VRAI setting (`chat_model`) qui est testé, au lieu d'une hypothèse erronée sur le setting Professeur.

Vérifié déterministe par 3 exécutions consécutives : 1/1 PASS à chaque fois.

**DB réelle utilisée : NON attendu** pour cette assertion — confirmé. (La lecture des clés cloud réelles en tout début de fichier, lignes 18-23, reste inchangée et n'a jamais été la cause de cet échec précis — déjà établi pendant la certification.)

---

## Résultats

```
test-maintenance :        PASS (1/1)
OpenRouter regression :   PASS (27/27 — test-openrouter-regression.mjs + test-teacher-fallback.mjs)
Privacy regression :      PASS (100/100 — test-privacy-guard.mjs, test-phase1-egress-certification.mjs,
                                 test-strict-local-centralized.mjs, test-ai-provider-fallback.mjs)

Suite complète :          511/511 PASS
Fichiers de suite :       35
Nouveaux skipped :        0
Nouveaux échecs :         0

Typecheck :                OK (frontend + cortex-server)
Build :                     OK

Cloud live :                0
Credential réel modifié :   NON
DB réelle modifiée :        NON (cortex.sqlite : taille/mtime/row counts identiques avant/après —
                                 19 542 016 octets, 16/09/2026 00:27, pages=6731, request_logs=67337,
                                 activity_log=324)
Donnée utilisateur supprimée : 0
shell:true ajouté :         0
```

**Fichiers modifiés** : `cortex-server/test-maintenance.mjs` uniquement (+10 lignes — un `setRouterSettings({ chat_model: 'dedicated:latest' })` et son commentaire d'explication). Aucun fichier de production touché. Confirmé par `git diff --stat` : seule entrée nouvelle par rapport à l'état précédent.

---

## FINAL-F1 CORRIGÉ — SUITE COMPLÈTE VERTE 511/511

STOP. Aucune autre modification ne sera lancée.
