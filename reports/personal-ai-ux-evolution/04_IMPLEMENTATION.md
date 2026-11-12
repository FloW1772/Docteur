# 04 — Implémentation (fichiers de cette mission)

Tous non stagés. « Suivi » = fichier versionné modifié ; « nouveau » = non suivi. Aucun de ces fichiers n'était modifié avant
la mission.

| Fichier | Type | Lignes | Rôle |
|---|---|---|---|
| `cortex-server/src/lib/companion-action-registry.js` | suivi | +48 −3 | action REMEMBER (utilisateur seulement), champ `text` borné |
| `cortex-server/src/lib/companion-actions.js` | suivi | +55 −9 | origine revérifiée à chaque étape ; brouillon REMEMBER en RAM ; liaison HMAC par processus (digest, hash d'aperçu, paramètres stockés) ; brouillon perdu ⇒ refus explicite |
| `cortex-server/src/lib/companion-contracts.js` | suivi | +9 | `createEphemeralBinder()` (HMAC-SHA256, clé aléatoire en mémoire) |
| `cortex-server/src/lib/companion-memory.js` | suivi | +15 −1 | `rememberCheck()` sans écriture ; plus d'empreinte du texte dans l'audit `MEMORY_ADDED` |
| `cortex-server/src/lib/companion-conversation.js` | suivi | +51 −2 | `contextSources` (éléments transmis, extraits bornés, re-filtre secrets, libellé du graphe intact) |
| `cortex-server/src/lib/wire-companion-conversation.js` | suivi | +7 −1 | n'affiche plus un souvenir désactivé/oublié pendant la génération |
| `cortex-server/src/routes/companion.js` | suivi | +10 −3 | corps borné + JSON strict ; champs de proposition fermés ; log d'erreur sans message |
| `src/components/companion/CompanionRememberForm.tsx` | nouveau | 47 | formulaire |
| `src/components/companion/CompanionPanel.tsx` | suivi | +17 −2 | branchement, anti double envoi, retour du focus |
| `src/components/companion/CompanionActionReview.tsx` | suivi | +13 −4 | aperçu du texte complet, anti double confirmation/exécution |
| `src/components/companion/CompanionChat.tsx` | suivi | +17 −1 | « Contexte transmis au modèle » / « Aucune source personnelle » |
| `src/lib/companion/ui-contracts.ts` | suivi | +10 −1 | types, message de réussite réelle |
| `src/lib/cortex/client.ts` | suivi | +2 −2 | conserve `reason` des erreurs KG |
| `src/lib/kg/kg-availability.ts` | nouveau | 39 | messages selon le motif réel |
| `src/components/modals/KnowledgeGraphModal.tsx` | suivi | +15 −2 | panneau indisponible |
| `src/content/capabilities.ts` | suivi | +3 −3 | aide Companion, Knowledge Graph, Notebook et Docteur Memory |
| `cortex-server/test-companion-actions.mjs` | suivi | +205 −4 | REMEMBER : NB-5 réel temporaire, geste, digest, double exécution, oubli, redémarrage, absence de texte et d'empreinte devinable, bout en bout réponse |
| `cortex-server/test-companion-model-actions.mjs` | suivi | +37 −1 | refus modèle de REMEMBER |
| `cortex-server/test-companion-context.mjs`, `test-companion-chat-safety.mjs`, `test-companion-kg-wiring.mjs` | suivis | +30 / +22 −2 / +10 −2 | sources transmises, révocation, imports |
| `scripts/test-companion-product-browser.mjs`, `scripts/test-companion-chat-browser.mjs` | suivis | +38 −3 / +15 | navigateur : formulaire, sources |
| `scripts/test-knowledge-graph-browser.mjs` | suivi | +5 −2 | motif réel au lieu de l'ancien texte « KG-CERT » |
| `scripts/test-kg-availability-unit.mjs` | nouveau | 24 | messages KG |

Contrats certifiés modifiés délibérément (non gelés, à revoir) :
- invariant « aucun champ texte libre » affiné : vrai pour toute action proposable par le modèle ; un seul champ texte, dans
  une action utilisateur, borné à 400 caractères ;
- liste fermée des actions : 7 → 8 ;
- liste exacte des imports de `companion-conversation.js` (+ détecteur de secrets pur).

Normalisation : 9 fichiers avaient été convertis en CRLF par mes éditions Python (5 de cette mission, 4 du lanceur) ; remis
en LF sans changement de contenu, suites relancées.
