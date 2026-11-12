# 09 — Certification finale Companion Memory & IA locale (2026-10-22)

Périmètre : lot PAI-1 (`COMPANION.MEMORY.REMEMBER`, sources transmises, UX associée), non commité.
Aucun commit, aucun push, aucun staging. Guide PDF privé, Arcade, MAÎTRE, Notebook, KG gelé et Root Policy non touchés.

## A. Revue des deux changements de contrat

| # | Point vérifié | Constat | Preuve |
|---|---|---|---|
| 1 | 7 → 8 actions | Registre toujours fermé, gelé, versionné ; ajout unique `COMPANION.MEMORY.REMEMBER` v1, `LOCAL_MUTATION`, `POINT_OF_NO_RETURN`, `NON_IDEMPOTENT`. Aucune classe nouvelle, aucune action EXTERNAL/HIGH_IMPACT activée. Aucune migration de schéma (tables d'actions existantes, `companion-boot.js` et `companion-schema.js` inchangés). | test registre (liste exacte des 8 ids) |
| 2 | Texte libre borné, utilisateur seul | Champ `text` : chaîne, 8 à 400 caractères, sans caractère de contrôle, espaces normalisés ; filtrage des secrets avant aperçu (`rememberCheck`) ; un seul champ texte dans tout le registre. | `test-companion-actions` (validation, `SECRET_SHAPE`) |
| 3 | Texte interdit aux propositions du modèle | Test épinglé : tout champ `text` ⇒ `modelProposable: false`, et seul REMEMBER en a un. Le parseur de sortie du modèle refuse REMEMBER (`MODEL_NOT_ALLOWED`) avant validation, aperçu ou écriture. | `test-companion-actions` l.350-355, `test-companion-model-actions` 10/10 |
| 4 | `modelProposable: false` sur tous les chemins | `requireOrigin` au parseur, à la proposition, et sur l'origine **persistée** à la revue, l'approbation et l'exécution (ligne MODEL forgée en base refusée). La route `POST /companion/proposals` n'accepte que `actionId` + `parameters` (aucune origine fournie par le client). | `test-companion-model-actions`, `test-companion-hardening` |
| 5 | Approbation humaine et contrôles NB-5 | Défi + intention `UI_GESTURE` à usage unique, digest exact, une seule exécution ; écriture par le service public NB-5 (`createManual` via `rememberExplicit`, `USER_EXPLICIT/USER_INPUT`) : refus des secrets, confirmation des faits sensibles, doublons, mémoire globale OFF ⇒ refus. Rejoué en réel (scénarios 1-2). | `test-companion-human-approval` 9/9, sonde réelle |

Correction documentaire faite pendant cette revue : l'en-tête de `companion-action-registry.js` affirmait encore
« jamais de texte libre » puis « seule une empreinte entre dans l'historique ». Il décrit maintenant l'état réel
(texte réservé à REMEMBER, utilisateur seul ; historique = catégorie + liaisons HMAC à clé de processus). Commentaire
seulement, aucun changement de comportement.

**Gouvernance — décision recommandée.** Companion n'est pas un module gelé, mais il est certifié
(PASS_WITH_LIMITATIONS) et le contrat certifié COMP-5 §22 disait explicitement : « chaque champ est un booléen, une
énumération, un id ou un entier borné — **jamais de texte libre** ». Le lot PAI-1 change donc un invariant certifié.
L'objectif de cet invariant (aucune ligne de proposition, entrée de digest ou entrée d'audit ne porte une phrase, un
prompt ou un secret) est préservé et testé, mais la règle écrite ne l'est plus.

Recommandation : **approbation humaine distincte, explicite et documentée** d'un amendement « COMP-5 contrat v1.1 »
couvrant exactement : (a) 8 actions ; (b) un champ `text` borné autorisé uniquement pour une action `modelProposable:
false`, le texte restant hors des tables d'actions (brouillon RAM + HMAC à clé de processus). Cette approbation n'est
**pas** déduite de la présente certification. Tant qu'elle manque, le lot reste non commité.

## B. Confidentialité

| Point | Résultat | Preuve |
|---|---|---|
| Texte brut absent des tables de propositions, approbations, audit chaîné | PASS (avant approbation, après exécution, après oubli) | tests + sonde s1/s2/s6/B |
| Aucune empreinte devinable stockée | PASS — digest, hash d'aperçu, liaison stockée = HMAC-SHA256 sous clé aléatoire de 32 octets ; empreinte simple de l'audit `MEMORY_ADDED` supprimée ; contrôle des SHA-256 simples du texte | test « no plain (guessable) hash », sonde B |
| Clé temporaire non persistée | PASS — la clé n'existe que dans la fermeture de `createEphemeralBinder` (jamais sérialisée, jamais journalisée) ; un autre processus produit un autre digest | lecture du code + test |
| Proposition interrompue par un redémarrage | PASS — `PREVIEW_STALE / DRAFT_UNAVAILABLE`, aucune écriture NB-5, aucune métadonnée ; annulé/refusé gardent `ACTION_NOT_ALLOWED` | test redémarrage |
| Oubli : aucune copie dans l'audit d'actions | PASS — NB-5 (ligne, FTS, vecteur), métadonnées Companion, propositions liées, références de session vérifiés vides ; audit NB-5 = id/action/statut seulement | sonde s6, test REMEMBER |
| Journaux sans contenu personnel | PASS — journaux Companion = ids, codes, compteurs (10 entrées capturées, ni texte du souvenir ni texte de la question) ; audit modèle sans texte | sonde B |
| Tests de suppression/désactivation | Corrects : ils vérifient l'absence dans le contexte envoyé, dans les sources affichées et dans chaque stockage, pas seulement un statut | relecture + sonde s6/s7 |

**Révocation pendant une génération — trois choses distinctes** (mesurées en réel, scénario 9) :

1. **Retrait de la provenance** : après « Ne plus utiliser » ou « Oublier », la source n'est plus affichée sous la
   réponse (`canShowMemorySource`, vérifié au moment de l'affichage). PASS.
2. **Arrêt de la génération** : la révocation **n'arrête pas** la génération en cours. Seule l'annulation explicite
   (signal d'arrêt) l'arrête : `MODEL_CANCELLED`, connexion fermée par le client avant toute réponse. PASS.
3. **Contenu déjà présent dans la réponse produite** : le texte avait déjà été transmis au modèle avant la révocation ;
   dans les deux essais réels (désactivation, puis oubli pendant la génération) la réponse **contenait** l'information
   révoquée. Masquer le libellé de source ne l'efface ni de la réponse, ni du modèle pour cette requête.

Il ne faut donc jamais présenter la suppression du libellé de source comme un effacement d'une information déjà
envoyée au modèle. Garanties réelles : la requête suivante ne la reçoit plus (scénarios 6-7), aucun historique de
conversation n'est conservé côté Companion, et Ollama (journal non debug) n'a écrit ni le souvenir ni la question.

Limites résiduelles : SQLite sans `secure_delete` (pages libérées et WAL peuvent garder des octets jusqu'à
réécriture ; les sauvegardes Docteur ne copient que les neurones, pas NB-5, mais une copie du disque faite hors
Docteur conserverait l'état) ; `MEMORY_PROPOSED` garde une empreinte simple (chemin sans appelant produit) ; la taille
du corps HTTP est journalisée (longueur du texte).

## C. Validation réelle avec Ollama

Autorisée explicitement par la personne : instance de test dédiée, puis arrêt de cette seule instance.

- Instance : une instance locale de test `ollama serve`, dédiée à cette sonde ; le cloud Ollama était désactivé dans
  sa configuration effective, lue dans son journal. Aucun téléchargement : modèles déjà présents. Modèle choisi par
  le routeur (AUTO) : `llama3.2:3b`.
- Écoute : 127.0.0.1:11434 et 127.0.0.1 (runner) seulement. Surveillance des connexions des processus `ollama*`
  pendant toute la sonde : 24 échantillons, **0 connexion externe**. Côté Docteur : `fetch` limité au loopback,
  **0 appel externe**, `strict_local_mode` actif.
- Isolation : base NB-5 temporaire, store Companion temporaire, graphe synthétique temporaire (activé + peuplé par le
  mécanisme officiel, ouvert en lecture seule), souvenir fictif (« ZEPHYRIN-42 », « vert céladon »). Bases réelles
  hachées avant/après : inchangées. Aucune note réelle.
- Arrêt : l'instance de test, puis son processus runner (enfant vérifié de cette instance) ; plus rien n'écoute sur 11434.

| # | Scénario | Résultat |
|---|---|---|
| 1 | Retenir une information fictive | PASS — proposition USER, aperçu du texte complet, rien d'écrit avant approbation |
| 2 | Confirmer l'enregistrement | PASS — geste UI + exécution, `MEMORY_REMEMBERED`, une écriture NB-5 `USER_EXPLICIT` |
| 3 | Question qui en dépend | PASS — réponse locale `llama3.2:3b` : « Le nom de code de ton projet fictif de test est ZEPHYRIN-42. » (observé) |
| 4 | Contexte réellement envoyé | PASS — octets capturés par le proxy loopback : une requête `/api/chat`, contient le souvenir, aucun outil |
| 5 | Sources affichées | PASS — 1 source MEMORY `TRANSMITTED / NOT_ASSESSED / NONE`, extrait ≤ 160 ; question graphe : 3 sources KNOWLEDGE_GRAPH du graphe de test, souvenir non pertinent non envoyé |
| 6 | Désactiver puis oublier | PASS — désactivé : ni envoyé ni listé ; oubli `COMPLETE`, NB-5/FTS/vecteur/métadonnées vides |
| 7 | Nouvelles réponses | PASS — rien envoyé, rien listé, recherche NB-5 vide ; le modèle répond ne pas connaître le projet |
| 8 | Modèle indisponible | PASS — Ollama arrêté (port réel) et port fermé : `LOCAL_MODEL_UNAVAILABLE / RUNTIME_UNAVAILABLE`, aucun autre runtime, aucun cloud |
| 9 | Confidentialité et révocation pendant la génération | PASS sur les garanties (source masquée, oubli complet, annulation qui ferme le transport) ; **observé** : contenu révoqué présent dans la réponse en cours (voir B) |

Sonde : 58/58 contrôles (instance active) + 7/7 (instance arrêtée).
Script et résultats : `.tmp/companion-memory-local-ai-cert/` (`probe.mjs`, `probe-up-result.json`,
`probe-down-result.json`, `netmon.log`, journaux Ollama).

## D. Régressions

Rejouées après la correction de l'en-tête, Docteur et Ollama arrêtés, bases temporaires seulement. Journaux :
`.tmp/companion-memory-local-ai-cert/logs/`.

| Suite | Résultat |
|---|---|
| Companion : actions 38 · model-actions 10 · human-approval 9 · memory 16 · hardening 15 · context 21 · chat-safety 6 · kg-wiring 27 · kg 21 · model 14 · 8b-wiring 5 · activation 8 · status-projection 3 | 193/193 PASS |
| `test-companion-real-local` | 7 SKIP (instance de test déjà arrêtée) — remplacé par la sonde réelle de la section C |
| Strict Local 6/6 · Web Egress 54/54 · statique Web Egress 7/7 | PASS |
| Root Policy : intégrité 38/38 · moteur 30/30 | PASS |
| Frontend unitaire : chat 9 · UI 8 · graphe 8 · disponibilité KG 2 | PASS |
| Navigateur isolé : UI Companion 13/13 (191 assertions) · chat 15 scénarios (55) · produit 120 · Knowledge Graph 128 | PASS |
| `tsc --noEmit` | exit 0 |
| Build Vite isolé (nouveau répertoire `.tmp/companion-memory-local-ai-cert/build-final`) | PASS |
| `git diff --check` | propre |
| Bases réelles (`cortex.sqlite`, WAL, store Companion) hachées avant/après | inchangées |

**Échecs historiques, documentés séparément (non corrigés, rien modifié pour les rendre verts) :**

- **NB-7** `test-nb7-chat-memory` 23/24 — test 24 (garde lexicale de câblage) signale `companion-contracts.js`,
  `companion-memory.js`, `companion-schema.js`. Preuve rejouée (`nb7-baseline-proof`) : les **mêmes trois fichiers** sont
  signalés sur HEAD et sur l'arbre de travail, garde identique à HEAD, 0 nouveau signalement. Préexistant.
- **Root Policy statique** 12/13 — test 11 « FROZEN modules … none of their files differs from HEAD » : seuls
  `maitre-executor.js` et `maitre-windows-exec.js` diffèrent (correctifs MAÎTRE approuvés MAITRE-REG-1 / MAITRE-STARTUP-1,
  non commités). Sans lien avec ce lot. Root Policy : 0 mutation, aucune signature.

## E. Classement

**`COMPANION_MEMORY_LOCAL_AI_PARTIAL`**

Toutes les validations techniques demandées ont été exécutées et passent, y compris avec un vrai modèle local.
Le classement n'est pas CERTIFIED pour une seule raison : les deux changements du contrat certifié (8 actions ;
champ texte borné réservé à une action utilisateur) n'ont pas encore reçu d'approbation humaine distincte, et cette
certification ne doit pas valoir approbation implicite. Si la personne approuve explicitement l'amendement décrit en A,
le classement devient `COMPANION_MEMORY_LOCAL_AI_CERTIFIED` sans test supplémentaire, avec les limites de la section B.

Fichiers modifiés par cette mission : `cortex-server/src/lib/companion-action-registry.js` (en-tête, commentaire
seulement) ; `reports/personal-ai-ux-evolution/09_FINAL_CERTIFICATION.md` (nouveau) ;
`reports/personal-ai-ux-evolution/CONTINUATION_CHECKPOINT.md` ; fichiers de travail sous
`.tmp/companion-memory-local-ai-cert/` (ignoré par Git).

Git : HEAD = origin/main = `b9eeeb4`, staging 0, commit 0, push 0 ; 27 fichiers suivis modifiés (inchangé).

## COMP-5 v1.1 — Human contract approval

- **Décision** : 2026-10-22, approbation explicite de l'utilisateur propriétaire de Docteur, intervenue **après** la
  création du checkpoint ci-dessus. Le classement `COMPANION_MEMORY_LOCAL_AI_PARTIAL` de la section E était exact au
  moment de sa création ; il est conservé tel quel comme trace historique.
- **Périmètre** : uniquement les deux changements examinés — registre 7 → 8 actions (seul ajout
  `COMPANION.MEMORY.REMEMBER`) ; champ texte de 8 à 400 caractères réservé à REMEMBER d'origine utilisateur. Le modèle
  ne peut toujours pas proposer REMEMBER. Aucune autre évolution n'est couverte.
- **Document officiel** : `reports/personal-ai-ux-evolution/10_COMP5_V1_1_CONTRACT_AMENDMENT_DECISION.md`
  (statut `APPROVED_BY_USER — COMP5_CONTRACT_V1_1`).
- **Empreintes** : listées dans le document 10 (registre `16f12cbe…0520`, actions `0c957f4a…2c40`, contrats
  `96c3431e…1295`, mémoire `d003d33c…5c99`, route `0bbe2f17…70f8`, + fichiers associés). Vérification : diff du registre
  purement additif ; aucun fichier de code ou de test modifié après le début de la sonde réelle ; les versions approuvées
  sont celles qui ont été certifiées.
- **Résultats de certification** : ceux des sections C et D (2026-10-22), **non rejoués** pour cette décision ; toujours
  applicables puisque le code est identique.
- **Limites restantes** : révocation pendant génération (NOT_FIXED), effacement physique SQLite (NOT_GUARANTEED),
  empreintes `MEMORY_PROPOSED` (OPEN), longueur journalisée (KNOWN) — voir section B et document 10.
- **Publication** : aucune (staging 0, commit 0, push 0).

**Classement après approbation : `COMPANION_MEMORY_LOCAL_AI_CERTIFIED`, avec limites résiduelles.** CERTIFIED ne veut
pas dire : absence de toute vulnérabilité, révocation immédiate d'un contenu déjà envoyé au modèle, effacement physique
garanti, absence de métadonnées, ni autorisation de publication.
