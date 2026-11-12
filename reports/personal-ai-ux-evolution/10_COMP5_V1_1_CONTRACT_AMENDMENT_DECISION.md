# COMP-5 — Contrat des actions Companion — Amendement v1.1

| | |
|---|---|
| **Date d'approbation** | 2026-10-22 |
| **Autorité** | Décision explicite de l'utilisateur propriétaire du projet Docteur (« DOCTEUR — APPROBATION OFFICIELLE DE L'AMENDEMENT COMP-5 v1.1 »), après le checkpoint `DOCTEUR_COMPANION_MEMORY_LOCAL_AI_FINAL_CERTIFICATION_CHECKPOINT` classé `COMPANION_MEMORY_LOCAL_AI_PARTIAL` |
| **Statut** | `APPROVED_BY_USER — COMP5_CONTRACT_V1_1` |

## Motif

Permettre à la personne de faire retenir volontairement une information au Companion, tout en conservant les
protections qui interdisent toute mémorisation à l'initiative du modèle.

## Ancien contrat (COMP-5, certifié)

Registre fermé de **sept** actions : `COMPANION.MEMORY.LIST`, `COMPANION.MEMORY.EXPLAIN`, `COMPANION.CONTEXT.EXPLAIN`,
`COMPANION.PREFERENCES.UPDATE`, `COMPANION.MEMORY.SET_ENABLED`, `COMPANION.MEMORY.SET_PRIVACY`,
`COMPANION.MEMORY.FORGET`. Paramètres : booléens, énumérations, identifiants, entiers bornés — **jamais de texte libre**
(rapport Companion V1 §22).

## Nouveau contrat autorisé (v1.1)

1. **Huit actions**, registre toujours fermé. Unique ajout : `COMPANION.MEMORY.REMEMBER` v1 (`LOCAL_MUTATION`,
   `NON_IDEMPOTENT`, `POINT_OF_NO_RETURN`, `modelProposable: false`).
2. **Un seul champ texte dans tout le registre** : `value` de REMEMBER, **8 à 400 caractères** après normalisation des
   espaces, sans caractère de contrôle, contrôlé côté serveur ; plus `category` (énumération des catégories durables).
   Champs inconnus refusés. Réservé à une proposition d'origine utilisateur.

## Frontière inchangée : le modèle ne mémorise jamais seul

Une demande REMEMBER provenant du modèle est refusée quel que soit son contenu, à chaque frontière :

| Frontière | Contrôle (code courant) |
|---|---|
| Lecture de la sortie du modèle | `parseModelActionOutput` : `modelProposable !== true` ⇒ `ACTION_NOT_ALLOWED / MODEL_NOT_ALLOWED` (registre l.395), avant validation, aperçu ou écriture |
| Création de proposition | `requireOrigin` (actions l.171) ; `POST /companion/proposals` n'accepte que `actionId` + `parameters` (aucune origine fournie par le client) ; `/companion/model-proposals` crée toujours une origine MODEL |
| Revue | `requireOrigin` sur l'origine **persistée** (l.201) |
| Approbation | `requireOrigin` sur l'origine persistée (l.239) + défi/intention `UI_GESTURE` à usage unique |
| Exécution | `requireOrigin` sur l'origine persistée (l.345) + digest exact + approbation non consommée et non expirée |
| Écriture mémoire | `rememberExplicit` → service public NB-5 uniquement, provenance `USER_EXPLICIT / USER_INPUT` |

Le contenu retrouvé (réponse IA, note Notebook, élément Knowledge Graph, résultat de recherche) reste de la donnée : la
réponse du Companion ne crée ni proposition ni action (`actionProposalIgnored`).

## Permissions inchangées

Approbation humaine obligatoire (usage unique, expiration, digest lié au texte exact, double exécution refusée, garde
anti-double-clic côté interface) ; écriture uniquement par le service public NB-5 (refus des secrets, confirmation des
faits sensibles, doublons, mémoire désactivée ⇒ refus, échec ⇒ aucune écriture) ; confidentialité : texte absent des
tables d'actions, de l'audit, des journaux et des erreurs ; empreintes HMAC sous clé de processus non persistée ;
brouillon perdu au redémarrage ⇒ refus propre `PREVIEW_STALE / DRAFT_UNAVAILABLE`.

## Vérification d'identité du code approuvé (2026-10-22)

- Diff du registre par rapport à HEAD `b9eeeb4` : **purement additif** (en-tête, import, `F.text`, branche `text` de
  `checkField`, définition REMEMBER, refus du parseur). Aucune ligne des sept définitions existantes modifiée.
- `requireOrigin` s'applique aussi aux sept actions : c'est un renforcement (revérification de l'origine persistée),
  sans changement pour les actions proposables par le modèle.
- Aucune neuvième action, aucun identifiant dynamique, catalogue EXTERNAL / HIGH_IMPACT toujours `DISABLED`, aucun
  import réseau ou système ajouté (imports de `companion-actions.js` limités à `./companion-*`, test épinglé), aucune
  migration (`companion-schema.js`, `companion-boot.js` inchangés).
- Dernier changement de code : l'en-tête du registre (commentaire seulement), fait **avant** la sonde Ollama réelle,
  elle-même suivie des régressions. Aucun fichier de `cortex-server/src`, `cortex-server/*.mjs`, `src`, `scripts` n'a
  été modifié ensuite. Les versions ci-dessous sont donc celles qui ont été certifiées.

### Empreintes SHA-256 auxquelles la décision s'applique

Fichiers dont **le contrat approuvé est une portion** (portions exactes indiquées) :

| SHA-256 | Fichier | Portion du contrat |
|---|---|---|
| `16f12cbe20e5488785ae0a31fd02f959fe7d569c012101c31403e6f7666e0520` | `cortex-server/src/lib/companion-action-registry.js` | l.13-16 en-tête ; l.56 `F.text` ; l.66-76 validation `text` ; l.259-288 définition REMEMBER ; l.395 refus du modèle |
| `0c957f4a4442d6e6325c19783b533f5d0ee5cfb2769ff5fc0521de5e1f602c40` | `cortex-server/src/lib/companion-actions.js` | l.102-150 brouillon RAM, liaisons HMAC, `DRAFT_UNAVAILABLE` ; l.160-164 `requireOrigin` et ses appels l.171/201/239/345 ; l.179-194 persistance sans texte |
| `96c3431edeeb25ae3bd7623519dce6c4a989f8bb2e66c549ff02c60ed6b61295` | `cortex-server/src/lib/companion-contracts.js` | l.67 `proposalValueChars` = 400 ; l.96 `createEphemeralBinder` |
| `d003d33c6cc1f09c4926c3266341dcd0d345b24f8783dd4ddf14e32c7eaa5c99` | `cortex-server/src/lib/companion-memory.js` | l.112 `rememberCheck` ; l.140-141 audit `MEMORY_ADDED` sans empreinte |
| `0bbe2f17f989fc8e4b7d2aa44747193874cd222e94677a49cf09512ed3d370f8` | `cortex-server/src/routes/companion.js` | l.100 `POST /companion/proposals` (champs fermés, corps borné, JSON strict) |

Fichiers du lot certifiés **dans leur intégralité** (comportement associé, hors texte du contrat) :

| SHA-256 | Fichier |
|---|---|
| `634c6d0ae62208f9f330290cc0e0be7ee675252de11405e758c2d227860acaa7` | `cortex-server/src/lib/companion-conversation.js` |
| `1c983aeaabb9c8b492692ffcabb1c70d1b6a61673527c3632885a676395fdc6c` | `cortex-server/src/lib/wire-companion-conversation.js` |
| `08b21f098b173902d6c43155d5502a1fd147821a80766ecf9b522ad39ec6a312` | `src/components/companion/CompanionRememberForm.tsx` (non suivi) |
| `d63bb15116f0da8bf0991f66fd0e94c88273954374455ceb61976de5e6ed2938` | `src/components/companion/CompanionPanel.tsx` |
| `aad19a296123cc53c7bafc9f818bbb1a26b1c060b9f04ed6b3cc1497471a4fbb` | `src/components/companion/CompanionActionReview.tsx` |
| `442fe502b43a85429699b6a938c1d925ea3f75b5d268092af0fa62542a6a5b04` | `src/components/companion/CompanionChat.tsx` |
| `cf2700dcf29b900bca3e8b34008d2678b3ef714e53d1c9f98891c86449117c48` | `src/lib/companion/ui-contracts.ts` |
| `41454a4b5f1a4c280ffce350df27a600009b4ede6cee592e76394f9b490b0fd2` | `cortex-server/test-companion-actions.mjs` |
| `a995cc031e087511417bb80b2d43f6d1a37bdba5dcf8e3cf7ee15fff21dbcc5c` | `cortex-server/test-companion-model-actions.mjs` |

Dépendances inchangées par rapport à HEAD (référence) : `companion-human-approval.js`
`7523f3e1b5471eebc503df7f202341ed673bfd88a11fde3599d5bd78836fe86c`, `companion-ui-service.js`
`0d309e61d0eb7aa3bda1759ebdc78bb0fc108658c17b56d37131aeb0fb4c7356`, `notebook-memory.js` (NB-5, gelé)
`e3f84310ac84384d44d7838ac2b9df7d21f4dfc46d79690604e700ec7912eb5f`.

Liste brute : `.tmp/companion-memory-local-ai-cert/comp5-v1.1-hashes.txt`.

**Toute version dont l'empreinte diffère n'est pas couverte par cette décision.**

## Preuves (exécutions du 2026-10-22, non rejouées pour cette décision)

- Tests qui prouvent les conditions : `test-companion-actions.mjs` — liste exacte des 8 ids ; « a free-text field is
  never model-proposable » et « seul REMEMBER a un champ texte » (l.350-355) ; REMEMBER : service NB-5 réel + geste UI +
  digest exact + une écriture (l.85) ; brouillon éphémère + redémarrage (l.120) ; aucune empreinte devinable (l.137) ;
  catégorie/texte/champs inconnus/secrets/mémoire OFF refusés avant persistance, origine forgée refusée (l.186) ;
  annulation/refus/expiration sans écriture (l.217) ; proposition MODEL persistée ni révisable, ni approuvable, ni
  exécutable (l.244). `test-companion-model-actions.mjs` l.60 : sorties hostiles du modèle refusées par parseur,
  facette, service et HTTP.
- Résultats : Companion 193/193 ; Strict Local 6/6 ; Web Egress 54/54 + 7/7 ; Root Policy intégrité 38/38, moteur
  30/30 ; frontend unitaire 27 ; navigateur 191 / 55 / 120 / 128 assertions ; `tsc` exit 0 ; build isolé PASS.
- Ollama réel (instance de test autorisée, local strict, `llama3.2:3b`) : 9 scénarios PASS, sonde 58/58, puis 7/7
  instance arrêtée, 0 connexion externe. Détails : `09_FINAL_CERTIFICATION.md` §C.

## Limites (non corrigées, non approuvées comme corrigées)

1. **Révocation pendant une génération** — NOT_FIXED : la source est retirée de l'affichage, mais la génération
   continue et la réponse peut reprendre le contenu déjà transmis (observé 2/2). L'oubli n'arrête pas la génération ;
   seule l'annulation explicite le fait. Mission séparée nécessaire.
2. **Effacement physique SQLite** — NOT_GUARANTEED : suppression logique et index vérifiés, pas les pages libérées, le
   WAL ni d'éventuelles copies faites hors Docteur.
3. **`MEMORY_PROPOSED`** — OPEN : empreinte simple conservée sur ce chemin distinct (sans appelant produit), non utilisé
   par REMEMBER ni par le formulaire.
4. **Journaux** — KNOWN : la taille des requêtes HTTP est journalisée (métadonnée de longueur, pas le texte).

## Exclusions

Aucune autre action ; aucun champ texte dans une autre action ; aucune action proposable par le modèle avec du texte ;
aucune modification de Root Policy ; aucune permission réseau ou système supplémentaire ; aucune migration de données ;
aucune publication (staging, commit, push, tag, release). L'amendement n'étend pas la dérogation MAÎTRE.

**Cette approbation ne s'étend à aucune version ultérieure sans nouvelle décision humaine.**
