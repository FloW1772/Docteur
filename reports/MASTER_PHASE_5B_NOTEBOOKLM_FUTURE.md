# MASTER PHASE 5B — Préparation future NotebookLM API (non activée)

Date: 2026-09-15
Branche: `main` (diff isolé, non commité)

## 1. Objectif

Préparer l'architecture d'une future intégration NotebookLM (Google) **sans l'activer** :
champ clé API stocké via DPAPI, aucun appel réseau réel quelle que soit la configuration,
export manuel local vers Markdown.

## 2. Ce qui a été construit

### 2.1 Stockage de la clé (DPAPI, aucun appel)
`cortex-server/src/routes/notebooklm.js` :
- `GET /api/notebooklm/status` — `{ key_configured, notice }`, jamais la clé en clair.
- `POST /api/notebooklm/key` / `DELETE /api/notebooklm/key` — stockage via le secret-store
  DPAPI existant (`secret-store.js`, réutilisé sans modification, clé `notebooklm_key`).
- **Aucun `fetch()` dans ce fichier** — vérifié par lecture complète et par test automatisé.

### 2.2 Abstraction NotebookProvider
`cortex-server/src/lib/notebook-provider.js` — exactement le modèle demandé par la mission :
```js
NOTEBOOK_PROVIDERS = {
  local:             { available: true },
  notebooklm_future: { available: false, reason: 'API_NOT_SUPPORTED' },
}
```
`assertNotebookProviderAvailable('notebooklm_future')` lève systématiquement
`NotebookProviderUnavailableError` (`code: 'NOTEBOOKLM_API_NOT_AVAILABLE'`). Cette fonction
n'est appelée par aucun chemin de code actif aujourd'hui — elle sert de porte explicite pour
une future intégration réelle, plutôt qu'un simple commentaire qu'on pourrait contourner par
erreur.

### 2.3 Indépendance totale vis-à-vis de routes/notebook.js
`routes/notebook.js` (Phase 5) n'importe **rien** de `notebooklm.js` ni de
`notebook-provider.js` — les deux fichiers sont complètement découplés. Une clé NotebookLM
configurée n'a strictement aucun effet sur le Q&A du Notebook local, qui reste local par
construction (aucun import de provider cloud dans ce fichier, confirmé en Phase 5).
**Aucun fallback Google n'existe et ne peut exister silencieusement** : un échec Ollama dans
`routes/notebook.js` ne peut pas "tomber" sur NotebookLM car ce fichier ne connaît même pas
son existence.

### 2.4 Export manuel "Préparer pour NotebookLM"
`POST /api/notebooks/:id/export-for-notebooklm` (ajouté à `routes/notebook.js`) :
- Écrit un fichier `.md` local dans `cortex-server/data/notebook-exports/` (déjà couvert par
  le `.gitignore` existant via `cortex-server/data/`) — aucun appel réseau.
- Pour un Notebook `local_only` : bloqué par défaut, nécessite `confirm: true` explicite
  (HTTP 409 avec `requires_confirmation: true` sinon) — conforme à l'exigence mission
  "bloqué par défaut ou confirmation forte explicite selon politique existante".
- Le message de retour rappelle explicitement qu'aucun appel à Google n'a eu lieu.

### 2.5 UI — Paramètres → IA → Notebook → NotebookLM/Google
`src/components/settings/NotebookLmSettingsSection.tsx` (nouveau), monté dans l'onglet
MODÈLES juste après le Free AI Finder (zone "IA" des Paramètres) :
- État "non configuré" : champ clé (masqué par défaut, œil pour afficher) + bouton
  Enregistrer.
- État "configuré" : "✓ Clé enregistrée (jamais utilisée pour un appel)" + bouton Supprimer.
- Texte explicite et non ambigu : *"Le Notebook local de Docteur fonctionne entièrement sans
  Google [...] aucun appel à l'API NotebookLM n'est effectué actuellement, même si une clé
  est enregistrée ici."*
- Bouton "Préparer pour NotebookLM" ajouté dans l'onglet OUTILS du NotebookModal (Phase 5),
  avec confirmation explicite si le Notebook est local_only.

## 3. Vérification visuelle (Playwright, base isolée)

Section NotebookLM confirmée visuellement dans Paramètres → Modèles, juste après le
catalogue Free AI, avec le texte d'avertissement lisible et le champ de saisie fonctionnel.

## 4. Tests

`test-phase5b-notebooklm.mjs` — **8/8 PASS** :
- `NOTEBOOK_PROVIDERS` : `local.available = true`, `notebooklm_future.available = false`,
  `reason = 'API_NOT_SUPPORTED'`.
- `assertNotebookProviderAvailable('notebooklm_future')` lève toujours
  `NotebookProviderUnavailableError` / `code: 'NOTEBOOKLM_API_NOT_AVAILABLE'`.
- Sauvegarde d'une clé : **0 appel réseau** (mock `fetch` qui lève une exception si appelé).
- `GET /status` : rapporte l'état sans jamais toucher le réseau, message "non actif" présent.
- Suppression de clé : **0 appel réseau**, secret réellement effacé du store.
- **Test critique** : un Notebook réel avec Q&A fonctionnel (Ollama factice), une clé
  NotebookLM configurée en parallèle → **0 appel réseau** pendant tout le flux `/ask`.
  Confirme qu'une clé configurée ne change absolument rien au comportement local.
- Vérification statique : `routes/notebook.js` n'importe rien de `notebooklm.js` ni ne
  référence d'endpoint Google (`googleapis.com`, `generativelanguage`).

Suite complète cumulée (Phases 0-5B) : **178/178 PASS**, 0 régression.

## 5. Typecheck / Build

- `npx tsc --noEmit` → OK.
- `npm run build` → OK.

## GATE PHASE 5B

| Critère | Résultat |
|---|---|
| Clé stockée via DPAPI, jamais en clair | Conforme |
| GET settings ne renvoie jamais la clé brute | Conforme (`key_configured: boolean` uniquement) |
| Aucun appel NotebookLM même avec clé configurée | Conforme, testé explicitement (0 fetch) |
| Message clair "clé enregistrée, aucun appel actuellement" | Conforme, affiché dans l'UI |
| Abstraction NotebookProvider (local vs notebooklm_future) | Conforme |
| Aucun fallback Google implicite | Conforme par construction (fichiers découplés) |
| Export manuel local uniquement | Conforme, testé |
| typecheck / build | OK / OK |
| Régression | 0 (178/178 tests) |

**PASS**

**→ CONTINUE vers PHASE 6 (choix du navigateur).**
