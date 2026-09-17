# PHASE 4 — Centre d'aide "?"

Mode : audit d'abord, extension ciblée du composant existant ensuite. Aucun deuxième système d'aide créé, aucun refactor global.

## Audit

Deux composants distincts existent, avec deux boutons distincts dans `TopBar.tsx` :
- **`HelpModal.tsx`** (icône `HelpCircle`, bouton "?" — `onHelpOpen`, titre "Aide — Capacités de Docteur (F1)") : le vrai centre d'aide visé par cette phase. Contenu statique (`src/content/capabilities.ts`) : capacités, limitations, raccourcis, gestes. Aucun accès direct, aucune recherche, aucun état.
- **`RoadmapModal.tsx`** (icône `Map`, bouton séparé) : journal d'audit développeur daté (progression réelle, décisions écartées) — **différent** du TODO de découverte mentionné en 4.7 du mandat. Laissé intact : le fusionner avec l'aide aurait mélangé deux usages différents (aide utilisateur vs suivi de développement), ce que la règle "ne pas créer un deuxième système d'aide" interdit aussi dans l'autre sens.

Inventaire des fonctionnalités réellement présentes fait en lisant `TopBar.tsx` (17 handlers `on*Open`), `App.tsx` (rendu conditionnel de chaque modal) et `SettingsModal.tsx` (10 onglets, dont 3 sections — NotebookLM, Navigateur, Sherlock — rendues dans l'onglet Modèles, pas dans un onglet dédié). Constat important : **le backend Google Drive/OneDrive/YouTube (`routes/connectors.js`, certifié Phase 1) n'a aucune interface frontend** — zéro référence à `connectors` dans `src/`. Documenté honnêtement comme limitation plutôt que comme fonctionnalité factice.

## Modifications

### `src/content/capabilities.ts`
- Ajout de `HELP_DIRECTORY` : 9 catégories (IA, Recherche et connaissances, Mémoire, Fichiers et capture, Audio, Images, Confidentialité, Outils, OSINT — adaptées aux fonctionnalités réellement présentes, pas la liste générique du mandat), **26 fonctionnalités référencées**, chacune avec nom, description, état (`disponible` / `local` / `à configurer` / `partiel`) et clé de navigation (`FeatureKey`).
- `LIMITATIONS` modernisée : suppression de 2 entrées obsolètes ("pas de transcription sans sous-titres — Whisper prévu" et "pas de mode vocal / Hey Docteur — prévu") — vérifié dans le code que Whisper (transcription vidéo, retest, fallback Groq) et Porcupine (mot-clé personnalisable, wake-word local) sont tous deux pleinement implémentés, pas seulement prévus. Ajout de 3 limitations réelles et actuelles : connecteurs sans UI, Sherlock non installé sur ce poste, Notebook sans FAQ/flashcards/chronologie.

### `src/components/modals/HelpModal.tsx`
- Nouveau bloc "répertoire des fonctionnalités" en tête de modale : chaque entrée affiche nom, état (badge coloré), description, bouton **Ouvrir**.
- Recherche simple (`<input>`, filtre sur nom/description/mots-clés) : au-delà de 26 entrées réparties en 9 catégories plus les sections Capacités/Raccourcis/Gestes existantes, la recherche apporte une vraie valeur (retrouver "drive", "mémoire", "images" sans scroller). Pendant une recherche active, les sections Capacités/Limitations/Raccourcis/Gestes (non concernées par la recherche) sont masquées pour ne pas noyer les résultats — réaffichées dès que la recherche est vidée.
- Titre changé de "Capacités de Docteur" à "Centre d'aide" (reflète le nouveau rôle), sous-titre mis à jour.
- Largeur de la modale : 600px → 720px (nécessaire pour la grille de fonctionnalités ; toujours `calc(100vw - 24px)` en dessous, donc toujours responsive).
- Contenu existant (Capacités/Limitations/Raccourcis/Gestes) conservé intégralement, inchangé dans sa structure.
- Style repris à l'identique du thème existant (mêmes couleurs, `IBM Plex Mono`/`Space Grotesk`, mêmes conventions de bordures/`backdrop`) — aucune nouvelle palette.
- Accessible : `aria-label` sur le champ de recherche, boutons natifs `<button>` (focus clavier natif), Echap ferme déjà la modale (comportement préexistant conservé).

### `src/App.tsx`
- `HelpModal` reçoit désormais `onOpenFeature`, qui ferme l'aide puis route vers le bon modal ou le bon onglet Settings selon la `FeatureKey` cliquée — réutilise les mêmes `setXxxOpen` déjà utilisés par `TopBar`, aucune nouvelle logique d'ouverture dupliquée.

### `src/components/modals/SettingsModal.tsx`
- Ajout d'un prop optionnel `initialTab` (type `Tab` désormais exporté) : permet d'ouvrir Settings directement sur l'onglet pertinent (ex. Mémoire, Images, Confidentialité) au lieu de toujours retomber sur "Modèles". Changement minimal (2 lignes) — pas de refactor de la logique d'onglets existante.

## Vérification

- **Typecheck** : `npx tsc --noEmit` — OK, aucune erreur.
- **Build** : `npm run build` — OK, 1.29s, précache 16 entrées (1780.86 KiB).
- **Test interactif réel** (Playwright, serveur de dev + backend cortex-server isolé sur DB de test jetable `/tmp/docteur-smoke-test`, jamais la vraie base — supprimée après usage) :
  - Ouverture du centre d'aide via le bouton "?" : OK.
  - 33 boutons "Ouvrir" affichés avant recherche.
  - Recherche "mémoire" → filtre à 1 résultat, contient bien "Mémoire adaptative", sections Capacités/Raccourcis masquées pendant la recherche : OK.
  - Recherche sans résultat → état vide affiché ("Aucune fonctionnalité ne correspond à…") : OK.
  - Clic sur "Ouvrir" (résultat "notebook") → centre d'aide se ferme, le vrai modal Notebook s'ouvre avec son contenu réel ("Notebook local", "Nouveau Notebook") : OK.
  - **0 erreur console, 0 erreur de page** sur l'ensemble du parcours.
  - Serveurs de test arrêtés et DB de test isolée supprimée après vérification ; base réelle (`cortex.sqlite`) vérifiée taille/date identiques avant/après (19 542 016 octets, 16/09/2026 01:44) — **jamais touchée**.
- **Fichiers modifiés** : `src/content/capabilities.ts`, `src/components/modals/HelpModal.tsx`, `src/App.tsx`, `src/components/modals/SettingsModal.tsx`. Aucun fichier backend touché, aucune nouvelle dépendance (`package.json` inchangé), aucun `shell:true`.

---

## GATE PHASE 4

```
AIDE "?" : PASS
Fonctionnalités référencées : 26
Accès direct : PASS
Recherche : OUI
Entrées obsolètes supprimées : 2
Typecheck : PASS
Build : PASS
```
