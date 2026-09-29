# DOCTEUR DEVICE FABRIC V2 — PHASE 2: OMEGA V2 OUTBOUND LINK + READ-ONLY STATUS

Date : 2026-09-28  
Périmètre : reprise et finalisation de la Phase 2 uniquement  
Verdict : **PASS**

## Résultat

Device Fabric possède maintenant un troisième type de lien, `OMEGA_V2_OUTBOUND`, séparé de `OMEGA` (OMEGA V1 inbound) et de `RASSILON`. Il permet de lier explicitement un appareil Fabric à un trust OMEGA V2 outbound existant, de résoudre exactement ce host et d'afficher un statut local en lecture seule.

La Phase 2 n'ajoute aucune commande distante : aucun routage VIEW, INTERACTIVE, ADMIN ou STOP, aucun connect automatique, aucun generic RPC et aucun nouveau listener. Aucun fichier `omega-outbound-*` certifié n'a été modifié.

## Séparation des espaces d'identité

| Domaine | Type de lien Fabric | Source d'identité | Format d'identité | Direction |
|---|---|---|---|---|
| OMEGA V1 | `OMEGA` | `omega_devices` | UUID OMEGA V1 | inbound : le device agit sur ce PC |
| OMEGA V2 | `OMEGA_V2_OUTBOUND` | `omega_v2_outbound_trust` | `ov2h-<uuid>` | outbound : ce PC connaît le host distant |
| RASSILON V1 | `RASSILON` | identité RASSILON | identité RASSILON | calcul selon le rôle RASSILON |

Ces identités ne sont jamais converties, fusionnées ou utilisées comme fallback les unes pour les autres. Un identifiant OMEGA V1 présenté comme host OMEGA V2 est rejeté. La réutilisation d'une même clé/fingerprint entre OMEGA V1, OMEGA V2 outbound et RASSILON est contrôlée dans les trois directions et échoue avec `cross_agent_key_reuse`.

## Base de données et migration

- Le `CHECK` de `fabric_agent_links.agent_type` accepte de façon additive `OMEGA_V2_OUTBOUND`.
- La migration reconstruit uniquement les tables à `CHECK` fermé qui doivent évoluer, copie les lignes existantes, puis recrée les index.
- Les liens OMEGA V1 et RASSILON existants sont conservés.
- `link_version` est ajouté avec une valeur initiale sûre (`1`) et est exposé avec le fingerprint lié comme fondation de revalidation TOCTOU.
- `fabric_audit` accepte les événements du nouveau lien sans élargir l'enum à des valeurs arbitraires.
- Aucun secret, certificat privé ou clé étrangère n'est ajouté aux tables `fabric_*`.

Migration dédiée : **3/3 PASS**. La simulation depuis l'ancien schéma conserve les lignes et ids existants, initialise `link_version = 1` et accepte le nouveau type.

## Linking explicite et résolution exacte

Le lien exige les trois valeurs suivantes :

1. un `fabricDeviceId` existant ;
2. un host `ov2h-*` déjà enregistré dans le trust OMEGA V2 outbound ;
3. une confirmation exacte du fingerprint d'identité affiché à l'utilisateur.

Il n'existe aucun auto-link ou auto-relink. Les hosts absents, révoqués, déjà liés ou dont le fingerprint ne correspond plus échouent de manière fermée. `resolveFabricOmegaV2Target()` relit le lien et le trust exact, refuse `MISSING`, `REVOKED` et `FINGERPRINT_MISMATCH`, puis retourne uniquement l'identité exacte, `linkId`, `linkVersion` et fingerprint. Il ne contacte aucun host et n'a aucun chemin de fallback.

`unlink` supprime seulement la ligne Fabric `OMEGA_V2_OUTBOUND`. Le trust OMEGA V2, OMEGA V1 et RASSILON restent inchangés. La suppression d'un appareil Fabric suit la même règle.

## Statut read-only et sémantique de disponibilité

Le statut sépare toujours :

- `SUPPORTED` : capacité décrite par le modèle OMEGA V2 ;
- `AUTHORIZED` : capacité sous le plafond du trust non révoqué ;
- `AVAILABLE` : preuve locale apportée par une session OMEGA V2 outbound existante.

Sans session existante observable, `AVAILABLE = UNKNOWN`, même si le trust et le lien sont valides. Un lien ou trust seul ne produit jamais `ONLINE` ni `AVAILABLE YES`.

Lorsqu'une session locale existante est visible en lecture seule :

- session VIEW : VIEW `YES`, INTERACTIVE/ADMIN `NO` pour AVAILABLE ;
- session INTERACTIVE : VIEW/INTERACTIVE `YES`, ADMIN `NO` ;
- session ADMIN : les niveaux permis par le trust peuvent être `YES`.

Le statut appelle uniquement les lectures locales du store OMEGA V2. Il ne fait jamais appel à `connectOmegaDevice()`, ne crée aucune session, ne paire rien et n'ouvre aucun flux distant. Un statut après restart ne réinvente donc aucune disponibilité.

## Décision de coût du probe

Phase 2 ne crée pas de ping léger et ne crée pas de session pour répondre à une question de statut. La décision volontaire de sécurité et d'honnêteté est :

> **AVAILABLE = UNKNOWN sans preuve locale existante.**

Un futur besoin de probe devra faire l'objet d'une mission séparée, avec son propre coût réseau, son modèle d'authentification, ses limites et ses tests. Aucun tel probe n'est implicite ici.

## UI

Chaque carte appareil affiche trois sections visuellement distinctes dans une grille responsive (une colonne sur petit écran, trois sur grand écran) :

- `OMEGA V1 — INBOUND` ;
- `RASSILON` ;
- `OMEGA V2 — OUTBOUND`.

La section OMEGA V2 affiche seulement l'adresse/identité host sûre, le fingerprint abrégé, l'état du lien, `SUPPORTED / AUTHORIZED / AVAILABLE`, les avertissements missing/stale/revoked/fingerprint mismatch et les actions `LINK` / `UNLINK`.

Le dialogue LINK liste seulement les trusts OMEGA V2 outbound non révoqués et non liés, affiche le fingerprint complet et exige une case de confirmation explicite avant l'appel API. UNLINK indique que la confiance OMEGA V2 est inchangée.

Il n'existe aucun bouton VIEW, INTERACTIVE, ADMIN, STOP ou CONNECT dans cette section. Une panne Cortex conserve visuellement un lien déjà connu mais masque trust et disponibilité en `UNKNOWN`; elle ne transforme pas le lien en faux `UNLINKED`.

Toutes les données host, id, fingerprint, statut, warning et erreur sont rendues comme texte React. `safeText` supprime les contrôles/bidi et borne les textes non fiables. Aucun HTML brut n'est inséré.

## Sécurité et secrets

Les tests dynamiques des lignes `fabric_*` après link confirment :

- clé privée OMEGA : **0** ;
- token OMEGA : **0** ;
- secret de session OMEGA : **0** ;
- approval OMEGA : **0** ;
- certificat privé brut : **0** ;
- secret réel suivi : **0**.

L'audit statique confirme que le module Phase 2 n'importe ni identité/signing/private-key store, ni création de session, ni fonction VIEW/INTERACTIVE/ADMIN/STOP. Les occurrences de mots tels que `execute`, `rpc`, `raw` ou `shell` dans l'audit sont uniquement des commentaires d'interdiction ou des variables de parsing existantes, pas des appels de contrôle.

Les routes OMEGA V2 Fabric exposent seulement hosts, link, unlink et status. Les chemins `/view`, `/interactive`, `/admin`, `/stop`, `/connect`, `/execute`, `/rpc` et `/raw` sont absents et testés à 404.

## Validation

| Suite | Résultat |
|---|---:|
| Device Fabric backend complet ciblé | **130/130 PASS** |
| Migration Device Fabric | **3/3 PASS** (incluse ci-dessus) |
| Static audit Device Fabric | **19/19 PASS** |
| Browser Device Fabric réel + API mock stateful | **100/100 PASS** |
| OMEGA V2 gelé | **77/77 PASS** |
| OMEGA V1 | **224/227 PASS**, 3 skips historiques |
| RASSILON V1 | **252/253 PASS**, 1 skip Ollama historique |
| TypeScript `npx tsc --noEmit` | **PASS** |
| Build `npm run build` | **PASS** |
| Smoke boot isolé | **3/3 PASS** |

Le test navigateur couvre notamment la séparation V1/V2, le rendu host hostile/XSS, la confirmation exacte du fingerprint, le succès du link, `UNKNOWN` sans session, les plafonds VIEW/INTERACTIVE/ADMIN d'une session existante, les états revoked/missing/fingerprint mismatch, unlink et la conservation du trust, ainsi que l'absence de boutons de contrôle.

Le smoke boot utilise un port loopback et des stores temporaires isolés. Il observe le démarrage, vérifie l'absence de log d'auto-connect/session OMEGA puis termine le processus sans listener résiduel.

### Backend complet

La sélection backend automatisée terminante (tous les `test-*.mjs` sauf les deux harness manuels non terminants `test-regression-api.mjs` et `test-video-manual.mjs`) donne :

- tests : **2653** ;
- pass : **2648** ;
- fail : **1** ;
- skipped : **4** ;
- cancelled : **0**.

Classification du non-pass :

- **ENVIRONMENTAL** — `test-find-eval.mjs` attend un frontend déjà lancé à `http://localhost:5173`; la relance isolée échoue de la même manière avec `ERR_CONNECTION_REFUSED`.
- **NEW Device Fabric V2** : **0**.
- **HISTORICAL skips** : 4 (dont les 3 OMEGA V1 et le smoke Ollama RASSILON attendus).

Une première invocation non bornée incluait `test-regression-api.mjs`; ce fichier lance intentionnellement un serveur fixture permanent sur le port 3002 et ne termine pas. Il a été identifié puis exclu de la sélection stable, sans modification du fichier.

## Limitations connues

- aucun routage VIEW ;
- aucun routage INTERACTIVE ;
- aucun routage ADMIN ;
- aucun routage STOP distant ;
- aucun heartbeat ou ping dédié ;
- disponibilité `UNKNOWN` sans session locale existante ;
- second appareil physique réel : `NOT_RUN`, acceptable pour cette Phase 2 ;
- les limitations certifiées propres à OMEGA V2 restent héritées telles quelles et ne sont pas requalifiées comme garanties Fabric supplémentaires ;
- sous Windows, le harness de boot observe la terminaison demandée comme signal `SIGINT` (sémantique `child.kill` Windows) plutôt que comme code POSIX 0 ; aucun processus ou listener de test ne subsiste.

## Fichiers du worktree Phase 2

- `cortex-server/src/lib/device-fabric.js`
- `cortex-server/src/lib/device-fabric-omega-v2.js`
- `cortex-server/src/lib/sqlite.js`
- `cortex-server/src/routes/device-fabric.js`
- `cortex-server/test-device-fabric-migration.mjs`
- `cortex-server/test-device-fabric-omega-v2-route.mjs`
- `cortex-server/test-device-fabric-omega-v2.mjs`
- `cortex-server/test-device-fabric-static-audit.mjs`
- `scripts/test-device-fabric-browser.mjs`
- `scripts/test-device-fabric-server-boot.mjs`
- `src/components/settings/DeviceFabricSettingsTab.tsx`
- `src/lib/cortex/client.ts`
- `reports/DEVICE_FABRIC_V2_OMEGA_ROUTING_ARCHITECTURE_2026-09.md` (rapport Phase 1 déjà présent dans le worktree repris)
- `reports/DEVICE_FABRIC_V2_OMEGA_LINK_STATUS_V1_2026-09.md`

## Conclusion

La Phase 2 est complète : lien OMEGA V2 outbound explicite, résolution exacte, fondation TOCTOU, statut honnête et read-only, UI séparée, migrations non destructives et régressions gelées validées. Phase 3 n'est pas commencée.

