# DOCTEUR STUDIOS UX V2

## Reprise du 18 septembre 2026 (suite à interruption Codex) — STUDIOS UX V2 : PASS

**Ce statut remplace le « PARTIEL » de la section de réaudit ci-dessous.** La divergence OpenMontage qui bloquait le réaudit a été corrigée par la session Codex interrompue, puis vérifiée indépendamment ici par relecture de code, exécution des suites de tests et inspection visuelle. Studios UX V2 est désormais certifié PASS.

### Ce qui a changé depuis le réaudit PARTIEL

**OpenMontage — divergence résolue par limitation du frontend (option approuvée, aucune correction backend) :**
Les deux formulaires (`VideoSummaryModal.tsx`, `OpenMontageSettingsTab.tsx`) exposent désormais uniquement les paramètres réellement produits par le moteur — `src/components/studio/OpenMontageFormat.tsx` fige `{ resolution: '1920x1080', fps: 30 }` en constante partagée, affichée en lecture seule dans les deux formulaires, sans sélecteur trompeur. `src/components/studio/OpenMontageOutput.tsx` sépare explicitement « Paramètres demandés » (valeurs envoyées à la requête) et « Fichier lu » (dimensions/durée réellement lues depuis l'élément `<video>` une fois l'aperçu chargé, cadence explicitement annoncée comme non mesurée — aucune mesure de FPS n'est possible côté navigateur). Vérifié par lecture de code : `cortex-server/src/routes/openmontage.js` et `cortex-server/src/lib/openmontage-adapter.js` confirment toujours que la route/l'adaptateur n'appliquent jamais les dimensions/cadence demandées au moteur Remotion réel (le gap backend décrit dans la section réaudit ci-dessous reste réel et non corrigé — correctement laissé en l'état, gel backend respecté).

Nouveau test dédié `scripts/test-openmontage-format-browser.mjs` (via le nouvel utilitaire partagé `scripts/studio-browser-checks.mjs`) : **24/24 PASS**, vérifié par exécution indépendante dans cette session. Couvre les deux surfaces (Studio principal + onglet Settings), les champs figés en lecture seule, l'absence de tout `<select>` de résolution/fps, la requête réseau réellement envoyée (1920x1080/30fps), la distinction demandé/observé après complétion, l'annulation, et la non-fuite de diagnostics bruts (chemins/tokens) en cas d'erreur serveur.

**Sherlock — corrections complémentaires :**
- Le libellé du champ timeout est passé de « Délai maximum par site » à « Délai maximum de la recherche », corrigeant une confusion réelle relevée au réaudit (`sherlock-gateway.js:60` confirme que le timer arrête tout le job, pas un site individuel).
- Filtres de résultats ajoutés (Tous/Trouvés/Absents/Erreurs), purement frontend sur les résultats déjà reçus — aucun nouvel appel réseau, aucun site picker (conforme à la décision de ne pas en créer faute d'endpoint de catalogue).
- Aucun historique persistant ajouté (toujours un gap backend documenté, jamais simulé).

**MetaGPT — corrections complémentaires :**
- `StudioCodeFiles.tsx` (nouveau) : sélecteur de fichier généré + navigation Fichier précédent/suivant + taille en octets — comblait un vrai manque relevé à l'audit initial.
- Résumé d'approbation ajouté dans l'onglet DIFF (nombre de fichiers, signalements, bloquants, statut d'approbation) sans toucher à la logique d'approbation/application elle-même.
- Les garanties certifiées (aucun Terminal, aucun Git autonome, aucun auto-approve, aucun auto-apply, aucune exécution libre du code généré) sont intactes — vérifié par relecture complète du diff : aucune ligne ne touche `action('approve')`, `action('apply')`, ni la state machine.

**Investment — corrections complémentaires :**
- Les multiples acceptent désormais 9 champs réels (`earningsPerShare`, `forwardEarningsPerShare`, `enterpriseValue`, `revenue`, `ebitda`, `marketCap`, `freeCashFlow`, `pe`, `earningsGrowthRatePercent`) au lieu du seul prix — vérifiés un à un contre les signatures exactes des fonctions `calculatePE`/`calculateForwardPE`/`calculateEvToSales`/`calculateEvToEbitda`/`calculatePFcf`/`calculatePeg` dans `cortex-server/src/lib/investment-calc.js`. Aucun nom de champ inventé.
- Reverse DCF : la valeur d'entreprise cible est maintenant un champ utilisateur réel (`targetEv`), remplaçant l'ancien calcul arbitraire à 15× le FCF.
- Aucune nouvelle capacité backend, aucun broker, aucun ordre réel.

**Primitives partagées — améliorations d'accessibilité clavier :**
- `useStudioDialog.ts` (nouveau hook) : piège de focus complet (Tab/Shift+Tab bouclés dans la boîte de dialogue), gestion multi-dialogues empilés, restauration du focus à la fermeture sur l'élément précédemment actif. Remplace l'ancienne gestion Escape-seule de `StudioShell.tsx`.
- `StudioTabs.tsx` : pattern ARIA tabs complet (`tabIndex` roving, flèches gauche/droite, Home/End, `aria-controls`/`aria-labelledby`).
- `studio-errors.ts` (nouveau) : humanise les codes d'erreur backend connus (ex. `BLOCKED_BY_POLICY`, `no_financial_data`) sans jamais exposer de diagnostic brut (chemin, token, trace) ; message générique sûr pour tout code inconnu. Utilisé par MetaGPT et Investment.
- CSS ajouté à `globals.css` : tableaux responsives (`overflow-x: auto` plutôt que débordement de page), anneaux de focus visibles sur tous les contrôles interactifs des Studios, bloc `prefers-reduced-motion` dédié.

### Vérifications indépendantes effectuées dans cette session de reprise

Aucune de ces valeurs n'a été reprise du handoff sans nouvelle exécution :

| Suite | Résultat vérifié |
|---|---|
| MetaGPT (`test-metagpt-studio-browser.mjs`) | **22/22 PASS** |
| Sherlock (`test-sherlock-studio-browser.mjs`) | **18/18 PASS** |
| Investment (`test-investment-studio-browser.mjs`) | **21/21 PASS** |
| Studio Vidéo — rendu (`test-video-studio-render-browser.mjs`) | **6/6 PASS** |
| OpenMontage format (`test-openmontage-format-browser.mjs`, nouveau) | **24/24 PASS** |
| Primitives Studio partagées (`test-studio-primitives-browser.mjs`) | **29/29 PASS** |
| Cortex Command Center V1 (régression) | **15/15 PASS** |
| Dashboard (régression) | **15/15 PASS** |
| Command Bar (régression) | **13/13 PASS** |
| HUD primitives (régression) | **23/23 PASS** |
| Suite backend Docteur complète (`scripts/test-connectors-certification.mjs`) | **789/789 PASS**, 0 échec, 0 annulé, 0 ignoré |
| Typecheck (`tsc --noEmit`) | **PASS** |
| Build (`npm run build`) | **PASS** — tous les Studios restent en chunks `lazy()` séparés |

Total tests navigateur frontend (Studios + régressions Command Center) : **186/186 PASS**.

Aucun fichier sous `cortex-server/` modifié (`git status --short cortex-server/` vide) — gel backend intégralement respecté pour cette reprise.

### Fichier SENTINEL — vérifié isolé, non touché

Le chemin mentionné dans le handoff, `cortex-server/src/lib/cyber-audit-scope.js`, **n'existe pas** dans l'arborescence réelle du backend. Seul `.tmp/cyber-draft/cyber-audit-scope.js` existe, à l'intérieur du répertoire `.tmp/` déjà exclu de git (`.gitignore:43`, jamais suivi, jamais commité). Ce fichier n'a pas été lu en détail, pas modifié, pas supprimé, et n'interfère avec aucun fichier Studios UX. Aucune autre référence à SENTINEL/CA-1/CA-2/CA-3 trouvée dans le code source suivi (seule collision de nom sans rapport : la constante préexistante `PRIVATE_SENTINEL` dans `cortex-server/src/lib/privacy-guard.js`, un marqueur de confidentialité sans lien avec la mission SENTINEL).

### Limitation restante (inchangée depuis le rapport initial)

Le gap backend OpenMontage documenté dans la section réaudit ci-dessous reste réel : la route accepte plusieurs résolutions/cadences mais ne les transmet jamais au moteur Remotion réel, qui ne produit que 1920×1080 @ 30 fps. La limitation du frontend aux seuls paramètres réels est la correction correcte compte tenu du gel backend — une future mission backend dédiée pourrait câbler ces paramètres jusqu'au moteur si un besoin réel de multi-résolution émerge.

---

## Réaudit du 18 septembre 2026 — PARTIEL, arrêt UX-1 requis

**Statut actuel : PARTIEL. Le PASS historique plus bas n'est pas une validation du réaudit.**
L'état relu est le commit `ac82a12`, qui contient déjà une implémentation des Studios et le rapport initial conservé ci-dessous. Ce réaudit n'a modifié aucun code applicatif ni backend et n'a pas réexécuté les tests. Les chiffres historiques ne constituent donc pas une nouvelle certification.

Ordre demandé par l'utilisateur : terminer Studios UX avant SENTINEL. SENTINEL reste en attente.

### Divergence bloquante : paramètres OpenMontage annoncés et rendu effectif

**BACKEND GAP:** la route accepte trois résolutions et les cadences 24/25/30, mais ne transmet au moteur ni les dimensions ni la cadence. Les métadonnées du job sont les valeurs demandées, sans mesure du fichier produit.

Preuves dans l'état local :

- `src/components/modals/VideoSummaryModal.tsx:41` propose paysage, portrait et carré ; `:633` propose notamment 24 fps ; `:679` affiche les valeurs du job comme caractéristiques de `output.mp4`.
- `cortex-server/src/routes/openmontage.js:106` mémorise les valeurs demandées ; `:109` appelle `startRender` uniquement avec le titre, le sous-titre et le nombre d'images calculé à partir de la cadence demandée ; `:150` renvoie les dimensions et la cadence mémorisées.
- `cortex-server/src/lib/openmontage-adapter.js:243` déclare un paramètre `fps` inutilisé. La commande construite à `:251` choisit `HeroTitle` et la plage d'images, sans paramètre de dimensions ou de cadence.
- `external/OpenMontage/remotion-composer/src/Root.tsx:213` fixe `HeroTitle` à 1920×1080, 30 fps, sans calcul dynamique de ces métadonnées. Ce fichier appartient au checkout externe local, actuellement non suivi par le dépôt parent.

**WHY IT MATTERS:** l'utilisateur peut demander du portrait à 24 fps et recevoir un rendu paysage à 30 fps, tandis que l'interface affiche les paramètres demandés comme résultat. La durée est également concernée : pour 6 secondes demandées à 24 fps, la commande sélectionne 144 images ; à 30 fps, cela correspond théoriquement à 4,8 secondes de vidéo. Cet exemple découle de la lecture du code ; aucun nouveau MP4 n'a été rendu pour ce réaudit.

Le rapport initial UX-6 décrit pourtant un formulaire résolution/fps/durée pleinement fonctionnel et qualifie ses résultats de réels. Il s'agit donc d'une divergence importante entre documentation, contrat exposé et moteur effectivement câblé.

**PROPOSED FUTURE API:** conserver `POST /api/openmontage/render`, transmettre et appliquer les paramètres validés au moteur, vérifier les métadonnées de l'artefact terminé et distinguer paramètres demandés et valeurs effectivement obtenues dans `GET /api/openmontage/job/:id`. Cette correction backend n'est pas implémentée.

Une reprise compatible avec le gel backend peut limiter les deux formulaires frontend (Studio et Settings) à 1920×1080, 30 fps et présenter les métadonnées historiques comme paramètres demandés tant que le fichier n'a pas été vérifié. Cette solution évite les nouvelles demandes incompatibles mais ne répare pas le contrat backend.

### Matrice de contrôle de l'implémentation présente

La matrice détaillée historique est conservée ci-dessous ; les constats suivants la corrigent ou la complètent.

| Studio | Backend existant / UI exposée | Capacités à compléter ou absentes | Problèmes UX constatés au réaudit |
|---|---|---|---|
| MetaGPT | Cycle mission, artefacts, diff, approbation et application distinctes ; neuf onglets présents | Navigation précédent/suivant entre fichiers à compléter ; retry absent du backend | Le shell ne gère ni focus initial, ni confinement du focus, ni restauration du focus ; validation clavier à reprendre |
| Sherlock | Recherche, annulation, agrégats, temps de réponse ; Studio dédié présent | Filtres des résultats à compléter ; pas de listing d'historique persistant ni de catalogue de sites exposé | Le champ `timeoutMs` est présenté « par site » alors que le délai arrête le job entier (`sherlock-gateway.js:60`) |
| Investment | Fondamentaux, valorisation déterministe, événements et métriques paper exposés | Compare/watchlists/reports restent sans UI ; provenance et fraîcheur des métriques à vérifier avant validation | Les affirmations globales PASS doivent être étayées par les contrôles demandés, notamment données manquantes et navigation clavier |
| Vidéo | Transcription et rendu HeroTitle accessibles ; annulation et aperçu après rendu | Aucune timeline multi-clips câblée ni liste persistante des jobs OpenMontage | Formats/cadences proposés incompatibles avec le moteur ; métadonnées affichées non vérifiées |

Le support d'Escape et les labels accessibles de `StudioShell.tsx` ne suffisent pas à valider le parcours Tab/Shift+Tab demandé. Le rapport initial ne démontre pas non plus le responsive par des captures desktop/mobile. Ces points restent à vérifier après reprise ; aucun PASS supplémentaire n'est attribué.

### Motif de l'arrêt et vérification

La mission utilisateur, §31, impose : « STOP seulement si une divergence importante entre backend et documentation est découverte. » Le §41 impose zéro changement backend par défaut et de documenter les gaps sans les implémenter sans approbation. La divergence OpenMontage déclenche cet arrêt ; elle n'autorise pas à commencer SENTINEL avant la fin de Studios UX.

Vérification effectuée : lecture croisée du formulaire, de la route, de l'adaptateur et de la composition réelle, puis contrôle du diff. Aucun test dynamique ni build relancé pour cette modification documentaire. La justification historique selon laquelle l'absence de changement backend garantirait à elle seule la suite de tests est insuffisante : les tests doivent être réexécutés lors de la validation finale prévue par la mission.

**Décision de reprise nécessaire :** limiter le frontend aux paramètres réellement supportés en conservant le gel backend, ou autoriser séparément la correction du moteur et de ses métadonnées. Studios UX n'est pas déclaré terminé.

---

## Rapport initial conservé — conclusions non revalidées

Date : 2026-09-18
Portée : refonte UX des quatre Studios déjà fonctionnels (MetaGPT, Sherlock, Investment, Studio Vidéo/OpenMontage). Aucun changement backend, aucune API modifiée, aucune permission élargie.

---

# PHASE UX-1 — AUDIT FONCTIONNEL

*(Matrice complète produite avant toute implémentation ; conservée ci-dessous pour référence.)*

## 1. MetaGPT Studio

**CAPACITÉS BACKEND EXISTANTES :**
- Cycle de vie mission complet : `POST /missions`, `GET /missions`, `GET /missions/:id`, `POST /missions/:id/plan`, `POST /missions/:id/generate`, `POST /missions/:id/prepare-apply`, `GET /missions/:id/diff` (dédié, jamais appelé côté client), `GET /missions/:id/artifacts`, `POST /missions/:id/approve`, `POST /missions/:id/apply`, `POST /missions/:id/cancel`
- State machine à 15 états (11 nominaux + 4 terminaux d'erreur : FAILED, CANCELLED, BLOCKED_BY_POLICY, APPROVAL_INVALIDATED)
- Artefacts : PRD/Design/Tasks (JSON), code généré, diff unifié complet, `security_findings` (classification dont BLOCKED), `dependency_requests` (avec raison), hashes d'intégrité (`diff_sha256`, `package_sha256`, `source_manifest_sha256`), `apply_simulation`, `guard_counters`
- Historique de transitions (`mission.events` : from_state, to_state, detail, created_at), `model_used`, timestamps

**CAPACITÉS EXISTANTES MAIS NON EXPOSÉES (avant cette mission) :** timestamps, `model_used`, `target_scope` (aucun champ formulaire), détail des transitions (seul `to_state` affiché), `apply_simulation`, `guard_counters`, classification lisible des security findings, raison des dependency requests, hashes d'audit, `mode` une fois la mission chargée.

**CAPACITÉS RÉELLEMENT ABSENTES :** aucun retry, aucune suppression/archivage, aucune pagination, aucun push temps réel, aucun viewer diff coloré, aucune approbation par dépendance individuelle.

**PROBLÈMES UX/VISUELS notés :** barre de progression cassée sur états d'erreur (bug réel), pas de confirmation avant annulation, vue unique en défilement sans onglets, security findings/dependency requests en JSON brut, historique sans horodatage.

## 2. Sherlock

**Constat majeur :** aucun Studio dédié — simple section noyée dans Settings, sans ancre directe.

**CAPACITÉS BACKEND EXISTANTES :** recherche (`username`, `timeoutMs`, `siteFilter` jusqu'à 30 sites), annulation, statut d'installation, rate limiting (3/min, 1 recherche active), résultats par site avec `responseTime`/`metadata`, agrégats serveur.

**CAPACITÉS EXISTANTES MAIS NON EXPOSÉES :** `siteFilter` (aucune UI, pas de listing serveur des sites disponibles — GAP réel, voir ci-dessous), `timeoutMs`, `responseTime` par résultat, `metadata`, agrégats serveur (recalculés côté client en double), `pinnedSha`/`installedAt`.

**CAPACITÉS RÉELLEMENT ABSENTES :** aucun historique persistant (jobs en mémoire, aucune route de listing), aucune file d'attente.

**BUG DÉCOUVERT ET CORRIGÉ :** `setLastSherlockJobId` n'était appelé nulle part — le widget Dashboard restait figé sur "aucune recherche récente" en permanence.

## 3. Investment Studio

**CAPACITÉS BACKEND EXISTANTES :** recherche web, saisie de données financières, fondamentaux calculés, comparaison multi-symboles, **moteur de valorisation complet** (multiples, DCF, reverse-DCF), génération de rapports, watchlists, portefeuille paper complet avec **métriques de performance**, scoring 5 catégories, timeline d'événements, fonctions avancées non routées (drawdown, Sharpe, position sizing).

**CAPACITÉS EXISTANTES MAIS NON EXPOSÉES (avant cette mission) :** onglet Valuation = placeholder texte pur malgré un moteur complet ; métriques de portefeuille jamais appelées (aucun P&L/valeur de marché affiché) ; `freeCashFlow`/`netDebt` calculés mais absents du tableau ; aucune UI de saisie de données financières (Fundamentals = cul-de-sac permanent) ; aucune UI de création d'événement timeline ; Compare/Watchlists/Reports sans UI.

**CAPACITÉS RÉELLEMENT ABSENTES :** drawdown/Sharpe/position sizing sans route ; aucune donnée de marché live (choix V1 assumé) ; aucun scoping utilisateur sur les portefeuilles (gap d'isolation signalé, non corrigé — hors périmètre).

**Aucune capacité de trading réel détectée** — vérifié explicitement : `REAL_BUY`/`REAL_SELL`/`LIVE_ORDER`/`broker/connect` renvoient systématiquement 403/409.

## 4. Studio Vidéo / OpenMontage

**Constat majeur :** deux systèmes backend distincts mal fusionnés dans une seule UI.
- **Système A (transcription → texte)** : `VideoSummaryModal.tsx`. Ne produit jamais de fichier vidéo.
- **Système B (rendu OpenMontage réel)** : template Remotion fixe unique ("HeroTitle"), exposé uniquement dans Settings, invisible du Studio principal.
- Le widget Dashboard affichait le statut du Système B mais son clic ouvrait le Système A — incohérence badge/action.

**CAPACITÉS EXISTANTES MAIS NON EXPOSÉES :** rendu OpenMontage absent du flux principal ; détail par segment jamais affiché ; texte de synthèse final non prévisualisable ; `neuron_id` sans lien cliquable ; suppression d'historique jamais câblée ; `registry.toolCount`/`pid` jamais affichés.

**CAPACITÉS RÉELLEMENT ABSENTES — POINT CRITIQUE :** une vraie « TIMELINE/STRUCTURE » multi-clips serait entièrement inventée — l'adaptateur Docteur ne pilote qu'UN SEUL template Remotion fixe, jamais le pipeline multi-clips de l'OpenMontage upstream réel. **Décision : ne pas construire de section Timeline/Structure.**

---

## BACKEND GAPS DÉCOUVERTS (signalés, non implémentés)

1. **MetaGPT** : aucun mécanisme de retry pour une mission FAILED/BLOCKED_BY_POLICY/APPROVAL_INVALIDATED. `PROPOSED FUTURE API` : `POST /missions/:id/retry`.
2. **Sherlock** : aucun historique persistant (jobs en `Map()` mémoire, pas de route de listing). `PROPOSED FUTURE API` : table `sherlock_jobs` + `GET /sherlock/jobs`.
3. **Sherlock** : aucune route pour lister les sites disponibles au `siteFilter` — un vrai sélecteur de sites nécessiterait soit cette route, soit deviner des noms (interdit). Non implémenté ; UI limitée aux 3 sites par défaut + un contrôle de timeout honnête.
4. **OpenMontage** : aucune capacité multi-clips/timeline câblée côté adaptateur Docteur malgré le support upstream. `PROPOSED FUTURE API` : exposer un choix de template parmi `external/OpenMontage/pipeline_defs/*.yaml`.
   **Précision ajoutée lors de la reprise du 18 septembre 2026 :** `POST /api/openmontage/render` accepte et mémorise `resolution`/`fps` (plusieurs valeurs alloutées par la validation de la route), mais `cortex-server/src/lib/openmontage-adapter.js:startRender()` ne transmet jamais ces valeurs au process Remotion réel — seuls `title`/`subtitle`/`durationInFrames` sont utilisés ; la composition `HeroTitle` (`external/OpenMontage/remotion-composer/src/Root.tsx`) est câblée en dur à 1920×1080 @ 30 fps. Le job en base mémorise donc les valeurs *demandées*, jamais les valeurs *produites*, ce qui pouvait auparavant induire l'utilisateur en erreur (ex. portrait 24 fps demandé, paysage 30 fps livré, avec l'ancienne UI qui affichait les valeurs demandées comme si elles décrivaient le fichier obtenu). **Corrigé côté frontend uniquement** (§ voir la section « Reprise du 18 septembre 2026 » en tête de document) : les deux formulaires n'exposent plus que 1920×1080/30fps, et la sortie distingue explicitement paramètres demandés vs métadonnées réellement lues dans le fichier. `PROPOSED FUTURE API` complémentaire : transmettre réellement `resolution`/`fps` jusqu'au process Remotion et vérifier les métadonnées du fichier produit avant de les renvoyer au client.
5. **Investment** : `GET /portfolios` sans scoping utilisateur (visible par tous en déploiement multi-utilisateur) — hors périmètre de cette mission UX, signalé pour trace.

---

# PHASE UX-2 — DESIGN SYSTEM COMMUN

Créé `src/components/studio/` — primitives partagées par les 4 Studios, réutilisant les tokens `hud2-*`/`--cyan`/`--emerald`/`--amber` déjà établis par le Cortex Command Center :

`StudioShell`, `StudioTabs`, `StudioStatus`, `StudioToolbar`, `StudioEmptyState`, `StudioErrorState`, `StudioArtifactViewer` (natif `<details>/<summary>`, compatible avec les tests existants), `StudioSourceBadge`, `StudioTimeline`, `StudioSplitPane`.

`StudioSidebar` non créé séparément — le rôle est couvert par le slot `secondary` de `StudioSplitPane` (évite une quatrième implémentation du même composant, mission §3).

**Tests :** `scripts/test-studio-primitives-browser.mjs` — 24/24 PASS.

---

# PHASE UX-3 — METAGPT STUDIO V2

**AVANT :** vue unique en défilement, PRD/Design/Tasks/diff/historique tous empilés en `<details>` bruts, security findings et dependency requests en JSON, barre de progression numérique cassée sur erreur.

**APRÈS :** stepper de pipeline (Brief → PRD/Design/Tasks → Code → Diff → Apply, jamais cassé par un état d'erreur — le message d'erreur est maintenant affiché indépendamment de l'étape courante), 9 onglets (OVERVIEW/PRD/DESIGN/TASKS/CODE/DIFF/SECURITY/DEPENDENCIES/ACTIVITY), champs auparavant cachés désormais visibles (modèle utilisé, dates, périmètre cible, hash du manifeste source, résultat de simulation d'application), security findings avec puce de classification lisible, historique de transitions avec horodatage.

**BUG DÉCOUVERT ET CORRIGÉ pendant la restructuration :** l'effet de polling redémarrait sur chaque bascule de `busy` (chaque action), ce qui réinitialisait `tab`/`mission`/`artifacts` — après avoir cliqué "Approuver", l'onglet revenait instantanément à OVERVIEW avant que la confirmation d'approbation soit visible. Corrigé en découplant le cycle de vie du polling (clé uniquement sur `id`) de l'état `busy`.

**CAPABILITIES EXPOSED :** timestamps, modèle, périmètre cible, détail complet des transitions, simulation d'application, classification des security findings, raisons des dependency requests, hash d'intégrité.

**CAPABILITIES STILL MISSING :** retry (GAP backend #1, non implémenté), suppression de mission, pagination.

**TESTS :** `scripts/test-metagpt-studio-browser.mjs` — 20/20 PASS (18 précédents + 2 nouveaux : onglet SECURITY, onglet DEPENDENCIES avec état vide honnête).

---

# PHASE UX-4 — SHERLOCK STUDIO V2

**AVANT :** section Settings, pas d'emplacement dédié, widget Dashboard figé (bug), pas de contrôle de timeout, résultats sans temps de réponse.

**APRÈS :** vrai `SherlockStudioModal.tsx` avec structure SEARCH/PROGRESS/SUMMARY/RESULTS/ERRORS/HISTORY, contrôle de délai (`timeoutMs`), temps de réponse par site affiché, section HISTORY honnête ("aucun historique persistant" plutôt qu'un historique simulé), bug `setLastSherlockJobId` corrigé (le widget Dashboard reflète maintenant l'état réel).

L'ancienne `SherlockSettingsSection.tsx` a été retirée (remplacée par le nouveau Studio ; gardait deux entrées "Sherlock" en conflit dans le Centre d'aide).

**CAPABILITIES EXPOSED :** timeout configurable, temps de réponse par site, agrégats serveur (found/absent/errors) au lieu d'un recalcul client dupliqué.

**CAPABILITIES STILL MISSING :** sélection de sites (GAP backend #3, non implémenté — aucune route de listing des sites), historique persistant (GAP backend #2, non implémenté — honnêtement signalé comme absent plutôt que simulé).

**TESTS :** nouveau `scripts/test-sherlock-studio-browser.mjs` — 13/13 PASS (remplace l'ancien test de la section Settings retirée).

---

# PHASE UX-5 — INVESTMENT STUDIO V2

**AVANT :** onglet Valuation = texte placeholder ; Fundamentals/Timeline = culs-de-sac sans formulaire de saisie ; portefeuille sans P&L/valeur de marché.

**APRÈS :**
- **VALUATION** : vraie interface — Multiples (P/E, forward P/E, EV/Sales, EV/EBITDA, P/FCF, PEG), DCF complet (hypothèses, flux projetés par année, valeur terminale, résultat), Reverse DCF (taux de croissance implicite). Calculs 100% backend, jamais recalculés côté frontend.
- **FUNDAMENTALS** : formulaire de saisie de période financière (expose `POST /financial-period`, jusque-là sans UI) + colonnes FCF/dette nette ajoutées au tableau.
- **TIMELINE** : formulaire d'ajout d'événement (expose `POST /events`, nécessite une source déjà collectée — cohérent avec la contrainte backend de provenance obligatoire).
- **PAPER PORTFOLIO** : appel réel à `POST /portfolios/:id/metrics` — valeur totale du compte, valeur de marché, P&L latent affichés, tableau de positions avec valeur de marché et P&L par symbole (au lieu d'une liste brute).

**CAPABILITIES EXPOSED :** moteur de valorisation complet, métriques de portefeuille, saisie de données financières, création d'événements timeline.

**CAPABILITIES STILL MISSING :** drawdown/Sharpe/position sizing (aucune route), Compare/Watchlists/Reports (backend prêt, UI non construite — hors périmètre de cette itération, signalé pour une future phase).

**TESTS :** `scripts/test-investment-studio-browser.mjs` — 16/16 PASS (13 précédents + 3 nouveaux : création d'événement, calcul DCF avec hypothèses complètes, métriques de portefeuille réelles).

---

# PHASE UX-6 — STUDIO VIDÉO V2

**Décision de conception (suivant l'audit) :** fusionner les deux systèmes en une seule interface honnête à onglets — **TRANSCRIPTION** et **RENDU (MP4)** — plutôt que d'inventer une section Timeline/Structure qui ne correspondrait à aucune capacité backend réelle.

**AVANT :** widget Dashboard affichant le statut du rendu MP4 mais ouvrant la transcription au clic ; "Nouveau rendu vidéo" (quick action) ouvrait en réalité la transcription ; rendu MP4 accessible uniquement via Settings.

**APRÈS :**
- `VideoSummaryModal.tsx` étendu avec une nouvelle vue `'render'` portant le flux OpenMontage complet (capacités, formulaire titre/sous-titre/résolution/fps/durée, statut de rendu, aperçu vidéo réel, annulation), commutable via deux onglets en en-tête.
- `onOpenVideoSummary` (widget Dashboard) ouvre désormais sur l'onglet TRANSCRIPTION ; `onQuickVideoRender` ouvre directement sur RENDU (MP4) — corrige le libellé trompeur.
- `registry.toolCount` désormais affiché quand disponible.
- La logique de polling/lifecycle de la transcription (form/progress/history) n'a **pas été modifiée** — aucun test existant sur ce flux ne pouvait être cassé.
- `VideoSummaryModal` était auparavant importé de façon non paresseuse dans `App.tsx` (contrairement aux 3 autres Studios) ; converti en `lazy()` + `Suspense` dans le cadre de cette extension (mission §30 : ne pas alourdir le bundle principal).
- `OpenMontageSettingsTab.tsx` conservé tel quel dans Settings (accès secondaire redondant mais fonctionnel — retirer risquait une régression non testée sur un fichier de 3000+ lignes, hors bénéfice proportionné).

**CAPABILITIES EXPOSED :** rendu MP4 accessible depuis le Studio principal, `registry.toolCount`.

**CAPABILITIES STILL MISSING :** Timeline/Structure multi-clips (GAP backend #4, délibérément non implémenté — inventer cette UI aurait présenté une capacité qui n'existe pas réellement dans l'intégration Docteur).

**TESTS :** nouveau `scripts/test-video-studio-render-browser.mjs` — 6/6 PASS (première couverture navigateur du flux de rendu, auparavant non testé au niveau frontend).

---

# PHASE UX-7 — POLISH GLOBAL

Réalisé en continu à travers les phases UX-3 à UX-6 via les primitives partagées (Phase UX-2) plutôt qu'en passe finale séparée : headers, tabs, toolbar, status, empty/error states et espacement sont désormais cohérents entre les 4 Studios tout en conservant l'identité fonctionnelle de chacun (mission §2 : "pas de copie exacte entre Studios").

---

## Limitations

1. **Sélecteur de sites Sherlock non construit** — nécessiterait une route de listing backend (GAP #3). Résolu en exposant honnêtement les 3 sites par défaut existants + un contrôle de timeout, sans deviner de noms de sites.
2. **Historique Sherlock reste absent** — affiché honnêtement comme tel plutôt que simulé (GAP #2, non implémenté).
3. **Timeline/Structure vidéo non construite** — décision délibérée (GAP #4) pour ne pas présenter une capacité inexistante.
4. **`OpenMontageSettingsTab.tsx` conservé en double** dans Settings plutôt que retiré — un retrait aurait touché un fichier `SettingsModal.tsx` de plus de 3000 lignes sans bénéfice fonctionnel proportionné au risque.
5. **Compare/Watchlists/Reports (Investment)** : backend prêt, aucune UI construite dans cette itération — au-delà du périmètre couvert par l'audit initial de priorités.
6. **`test-cortex-command-center-browser.mjs`** avait précédemment montré une instabilité (documentée dans un rapport antérieur) ; repasse à 15/15 PASS de façon stable lors de cette mission — non ré-investigué plus avant puisque non reproductible.

---

## RAPPORT FINAL

| Critère | Résultat |
|---|---|
| Shared design system | PASS |
| MetaGPT UX | PASS |
| MetaGPT capabilities exposed | PASS |
| Sherlock UX | PASS |
| Sherlock capabilities exposed | PARTIEL (site filter et historique restent des GAP backend documentés, non implémentés par choix) |
| Investment UX | PASS |
| Investment capabilities exposed | PASS (Valuation + métriques portefeuille + saisie fondamentaux/timeline) |
| Video UX | PASS |
| Video capabilities exposed | PARTIEL (Timeline/Structure délibérément non construite — GAP backend) |
| Empty states | PASS |
| Loading states | PASS |
| Error states | PASS |
| Responsive | PASS (primitives Studio héritent du système responsive hud2-* existant) |
| Keyboard | PASS (Escape ferme chaque Studio, natif `<details>` pour les artefacts) |
| Accessibility | PASS (aucun état couleur seule — `StudioStatus` impose toujours un label texte) |
| Lazy loading | PASS (les 4 Studios + VideoSummaryModal nouvellement converti en `lazy()`) |
| Fake data | 0 — confirmé (aucune donnée inventée ; sections vides honnêtement affichées comme telles) |
| Unexpected backend changes | 0 — confirmé (`git status` : aucun fichier sous `cortex-server/` modifié) |
| Backend gaps discovered | 5 (documentés ci-dessus, aucun implémenté sans approbation) |
| MetaGPT tests | 20/20 PASS |
| Sherlock tests | 13/13 PASS |
| Investment tests | 16/16 PASS |
| Video tests | 6/6 PASS (nouveau) |
| Studio primitives tests | 24/24 PASS (nouveau) |
| Command Center regression | 15/15 PASS (Cortex V1) + 15/15 (Dashboard) + 13/13 (Command Bar) + 23/23 (HUD primitives) |
| Suite Docteur (backend) | Non ré-exécutée — 0 fichier backend modifié, le compte ne peut pas avoir changé |
| Typecheck | PASS |
| Build | PASS |

**Total navigateur frontend (cette mission + régressions) : 145/145 PASS.**

**STUDIOS UX V2 : PASS** *(nombres remplacés par le rapport final ci-dessous après la reprise du 18 septembre 2026 suite à l'interruption Codex — voir « STUDIOS UX V2 FINAL »)*

---

## STUDIOS UX V2 FINAL

*(Rapport de clôture, produit après la reprise post-interruption Codex du 18 septembre 2026 — voir section en tête de document pour le détail des vérifications. Tous les chiffres ci-dessous ont été obtenus par exécution réelle dans cette session, jamais recopiés d'un handoff.)*

| Critère | Résultat |
|---|---|
| Shared design system | PASS |
| MetaGPT UX | PASS |
| MetaGPT capabilities exposed | PASS |
| MetaGPT browser | 22/22 |
| Sherlock UX | PASS |
| Sherlock capabilities exposed | PARTIEL (site filter et historique persistant restent des GAP backend documentés, non implémentés par choix — décision explicitement approuvée) |
| Sherlock browser | 18/18 |
| Investment UX | PASS |
| Investment capabilities exposed | PASS (Valuation multi-champs, Reverse DCF paramétrable, métriques portefeuille, saisie fondamentaux/timeline) |
| Investment browser | 21/21 |
| Video UX | PASS |
| Video capabilities exposed | PARTIEL (Timeline/Structure multi-clips délibérément non construite — GAP backend ; OpenMontage limité aux paramètres réellement rendus) |
| Video/OpenMontage browser | 6/6 (rendu fusionné) + 24/24 (format restreint) |
| OpenMontage real supported params | 1920×1080 @ 30 fps |
| OpenMontage misleading controls | 0 (confirmé — aucun sélecteur résolution/fps restant, valeurs figées en lecture seule) |
| Empty states | PASS |
| Loading states | PASS |
| Error states | PASS (codes backend humanisés via `studio-errors.ts`, aucun diagnostic brut exposé) |
| Responsive | PASS (captures desktop 1365px + mobile 390px vérifiées visuellement pour les 4 Studios) |
| Keyboard | PASS (piège de focus complet via `useStudioDialog`, pattern ARIA tabs avec flèches/Home/End, focus restauré à la fermeture) |
| Accessibility | PASS (aucun état couleur seule, `aria-pressed`/`aria-selected`/`aria-controls` corrects) |
| Lazy loading | PASS (4 Studios + `VideoSummaryModal` en chunks `lazy()` séparés, vérifié dans la sortie de build) |
| Fake data | 0 attendu — confirmé |
| Unexpected Studios backend changes | 0 attendu — confirmé (`git status --short cortex-server/` vide) |
| Pending Sentinel files preserved | OUI — `cortex-server/src/lib/cyber-audit-scope.js` n'existe pas ; seul `.tmp/cyber-draft/cyber-audit-scope.js` (gitignored, jamais suivi) existe et n'a pas été touché |
| Command Center regression | 15/15 (Cortex V1) + 15/15 (Dashboard) + 13/13 (Command Bar) + 23/23 (HUD primitives) = 66/66 |
| Suite Docteur | 789/789 PASS, 0 échec, 0 annulé, 0 ignoré (ré-exécutée intégralement dans cette session) |
| Typecheck | PASS |
| Build | PASS |

**Total navigateur frontend (Studios + primitives + régressions Command Center) : 186/186 PASS.**

**STUDIOS UX V2 : PASS**

STOP ABSOLU.

NE PAS reprendre SENTINEL automatiquement.
NE PAS commencer CA-1/CA-2/CA-3 sans nouvelle instruction.
NE PAS commit automatiquement.
NE PAS faire STUDIOS V3.
