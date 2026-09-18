# DOCTEUR STUDIOS UX V2

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

**STUDIOS UX V2 : PASS**

STOP.

NE PAS commencer de nouvelles capacités backend.
NE PAS faire STUDIOS V3.
