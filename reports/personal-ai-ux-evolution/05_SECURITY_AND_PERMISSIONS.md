# 05 — Sécurité, permissions et confidentialité

## Le modèle ne peut pas mémoriser seul
- `COMPANION.MEMORY.REMEMBER` a `modelProposable: false`. Refus au **parseur** des propositions du modèle (avant toute
  validation, tout aperçu, toute écriture), au **service** de proposition (`requireOrigin`), et revérifié sur l'origine
  **persistée** à la revue, à l'approbation et à l'exécution (même une ligne MODEL forgée en base est refusée).
- Le client ne peut pas fournir d'origine : `POST /companion/proposals` n'accepte que `actionId` + `parameters` ; corps borné,
  JSON strict (clés dupliquées refusées).
- L'écriture n'a lieu qu'après une approbation humaine à usage unique (défi + geste de confiance), digest exact ; une seconde
  exécution est refusée ; un texte différent de l'aperçu est refusé (digest).
- Le contenu retrouvé (souvenirs, graphe) reste de la DONNÉE : la réponse ne crée ni proposition ni action.

## Texte privé
- Le texte à retenir n'entre **jamais** dans les tables immuables d'actions (propositions, approbations, audit chaîné). Il vit
  en RAM pendant la revue (durée de vie de la proposition), purgé à la décision ou à l'expiration.
- **Correction de cette reprise** : la version interrompue persistait trois empreintes SHA-256 simples dérivées du texte
  (`valueSha256`, digest d'action, hash d'aperçu contenant l'extrait). Un texte court est retrouvable par devinette. Les trois
  sont désormais des **HMAC-SHA256 sous une clé aléatoire propre au processus**, jamais écrite. L'empreinte simple de l'audit
  Companion `MEMORY_ADDED` a été supprimée. Test : aucune de ces empreintes devinables n'apparaît, même après oubli.
- Après redémarrage : clé et brouillon perdus ⇒ ancienne proposition inexécutable (`PREVIEW_STALE / DRAFT_UNAVAILABLE`) ⇒
  ressaisie. NB-5 reste l'unique stockage durable du souvenir.
- Journaux : loggers Companion = identifiants, codes, compteurs ; route en erreur = code seulement ; journal générique des
  requêtes = chemin, durée, taille en octets, statut (pas de corps). Limite : la taille du corps révèle la longueur du texte.
- Réponses API : `contextSources` affiche des extraits de 160 caractères au plus, re-filtrés contre les secrets, à l'interface
  locale de la personne seulement ; un souvenir désactivé ou oublié pendant la génération n'est pas réaffiché.

## NB-5
- Écriture uniquement par le service public NB-5 (`createManual`) : ses règles s'appliquent (refus des secrets, confirmation
  des faits sensibles — « Fait personnel » devient une note personnelle sensible confirmée par le contrat NB-5, doublons,
  portée). Aucune table `dmem_*` écrite directement, module gelé non modifié. Mémoire globale OFF ⇒ refus avant toute
  écriture. Échec de l'overlay ⇒ souvenir NB-5 annulé.

## Réseau et Root Policy
- Aucun appel réseau ajouté, aucun fournisseur cloud, aucun port. Strict Local 6/6, Web Egress 54/54 + 7/7.
- Root Policy V2 inchangée (VALID, v2, highestVersionSeen 2, `a8e4f7b5…bf9`), aucune signature.

## Résiduels
- `MEMORY_PROPOSED` (propositions de souvenirs dérivées par le modèle, sans appelant produit) garde une empreinte simple pour la
  détection de doublons : à traiter avant de brancher ce chemin.
- La taille du corps HTTP est journalisée.
