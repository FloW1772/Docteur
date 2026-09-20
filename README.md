# 🧠 Docteur

> Assistant IA personnel local et hybride pour organiser tes connaissances, interroger plusieurs modèles et automatiser tes tâches depuis une seule interface.

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React 18">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5">
  <img src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white" alt="Vite 8">
  <img src="https://img.shields.io/badge/SQLite-embarqu%C3%A9-003B57?logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Plateforme-Windows-0078D6?logo=windows&logoColor=white" alt="Windows">
</p>

<p align="center">
  <img src="screenshot_render.png" alt="Interface de Docteur" width="900">
</p>

## ✨ Pourquoi Docteur ?

🧠 **Mémoire personnelle**
Neurones, documents, recherche sémantique et connaissances centralisées dans une base locale.

🔒 **Local-first**
Chat, vision, transcription et embeddings peuvent tourner entièrement sur ta machine via Ollama, sans connexion Internet.

🤖 **Multi-provider**
Claude Code, Codex, Groq, Gemini, OpenRouter, Anthropic API, OpenAI API et autres intégrations configurables.

🧭 **Mode Strict Local**
Bloque les chemins applicatifs identifiés comme cloud lorsqu'il est activé, pour garder le contrôle sur où vont tes données.

⚙️ **Automatisation**
Agents planifiables, veille thématique, génération de prompts et outils spécialisés (CV, professeur).

🎥 **Multimédia**
Résumé vidéo, transcription, analyse d'image et OCR.

## ✅ Definition of Done — nouvelle fonctionnalité Docteur

Une nouvelle feature n’est pas terminée tant que :

- elle est enregistrée dans le catalogue central
- son statut est défini
- elle est explicable via le Local Explainer
- ses limites sont documentées
- ses implications sécurité / local / cloud sont indiquées
- les tests du registry passent

## 🚀 Démarrage rapide

```powershell
git clone https://github.com/FloW1772/Docteur.git
cd Docteur
npm install
cd cortex-server
npm install
```

Puis démarre le backend (`npm run dev` dans `cortex-server/`) et le frontend (`npm run dev` à la racine) dans deux terminaux, ou utilise le launcher Windows fourni (`Docteur-Launcher.bat`).

> [!NOTE]
> Le launcher Windows peut nécessiter d'adapter son chemin de projet si le dépôt n'est pas installé à l'emplacement prévu.

Détails complets dans la section [Installation](#-installation-détaillée) plus bas.

<details>
<summary><strong>📚 Table des matières</strong></summary>

- [Qu'est-ce que Docteur ?](#-quest-ce-que-docteur-)
- [Fonctionnalités principales](#-fonctionnalités-principales)
- [Cortex Command Center](#-cortex-command-center)
- [Studios (MetaGPT, Sherlock, Investment, Vidéo, Cyber Audit)](#-studios-metagpt-sherlock-investment-vidéo-cyber-audit)
- [Architecture](#-architecture)
- [Providers IA](#-providers-ia)
- [Routage IA](#-routage-ia)
- [Mode Strict Local](#-mode-strict-local)
- [Installation détaillée](#-installation-détaillée)
- [Configuration des IA](#-configuration-des-ia)
- [Données et stockage](#-données-et-stockage)
- [Sécurité et confidentialité](#-sécurité-et-confidentialité)
- [Formats supportés](#-formats-supportés)
- [Vidéo et transcription](#-vidéo-et-transcription)
- [Caméra et gestes](#-caméra-et-gestes)
- [RAG et documents](#-rag-et-documents)
- [Tests et qualité](#-tests-et-qualité)
- [Structure du projet](#-structure-du-projet)
- [Commandes utiles](#-commandes-utiles)
- [Dépannage](#-dépannage)
- [État du projet](#-état-du-projet)
- [Limitations connues](#-limitations-connues)
- [Roadmap](#-roadmap)
- [Contribuer](#-contribuer)
- [Signaler un problème de sécurité](#-signaler-un-problème-de-sécurité)
- [Licence](#-licence)
- [Technologies principales](#-technologies-principales)

</details>

## 🧠 Qu'est-ce que Docteur ?

Docteur est une application personnelle (frontend web + serveur local) qui rassemble dans un même endroit : des notes et documents (appelés **neurones**), une recherche dans ce que tu y as stocké, et l'accès à plusieurs modèles d'IA — installés sur ta machine ou fournis par un service cloud.

L'idée de départ : au lieu d'ouvrir dix outils différents (une note, un chat IA, un lecteur PDF, un résumé de vidéo…), tout passe par la même interface, avec le choix explicite d'utiliser un modèle local (Ollama) ou un modèle distant selon la tâche et tes préférences de confidentialité.

Docteur tourne en local sur ta machine : un serveur backend (`cortex-server`) répond sur `127.0.0.1`, et l'interface est une application web (React) que tu ouvres dans ton navigateur.

Docteur ne fonctionne pas intégralement hors ligne dès l'installation : sans Ollama installé et sans modèle local téléchargé, les fonctions IA n'ont rien à interroger.

## ✨ Fonctionnalités principales

### 🧠 Connaissances

- Création, édition et suppression de neurones (notes, liens, vidéos, CV, etc.), avec liens entre eux.
- Persistance SQLite locale, avec chargement rapide au démarrage (neurones récents d'abord, reste à la demande).
- Recherche par similarité vectorielle (embeddings Ollama, index LanceDB).
- Import documentaire : `.xlsx`, `.csv`, `.txt`, `.md`, `.json`, avec chunking pour le contexte envoyé au modèle.
- **Notebook local** : regroupe des sources existantes (neurones) dans un espace de travail dédié, questions/réponses avec citations structurées (jamais une source inventée), résumé global — RAG scopé uniquement aux sources du Notebook, jamais à l'ensemble de la base. Uniquement local (Ollama) : aucun appel cloud possible depuis ce module, par construction (le code ne connaît même pas de provider cloud). Voir [Notebook local](#-notebook-local).
- **Mémoire adaptative locale** : apprentissage progressif à partir des recherches, neurones créés et corrections en conversation — extraction 100 % locale (règles + option Ollama), jamais de contenu envoyé à un provider cloud pour décider quoi retenir. Budget de contexte borné (jamais toute la mémoire injectée), déduplication automatique. Réglable/consultable/réinitialisable depuis Paramètres → Mémoire.
- **Connecteurs YouTube et Microsoft OneDrive** — 🚧 architecture backend complète et testée (OAuth officiel, déduplication, stockage DPAPI), mais **aucune UI de connexion n'est encore disponible** et aucun compte réel n'a été testé (nécessite tes propres identifiants d'application Google Cloud / Azure). Tout contenu importé serait automatiquement marqué privé/local uniquement. Voir [Limitations connues](#-limitations-connues).

### 🤖 IA

- Chat avec un modèle local via Ollama.
- Routeur central qui choisit ou bascule entre providers selon disponibilité, clés configurées et mode Strict Local.
- Comparaison de plusieurs modèles sur la même question.
- Support Claude Code, Codex et providers API (Groq, Gemini, OpenRouter, Anthropic, OpenAI, FreeLLMAPI, PAIR).
- **Free AI Finder** : catalogue d'offres IA gratuites (communautaire), sépare clairement les providers déjà configurés dans Docteur de ceux à découvrir — jamais de provider déjà actif suggéré comme nouveauté.
- **NotebookLM (Google) — préparation future, non active** : un champ permet d'enregistrer une clé API par avance, mais **aucun appel à l'API NotebookLM n'est jamais effectué actuellement**, même avec une clé enregistrée. Le Notebook local fonctionne entièrement indépendamment de Google. Un export manuel (fichier Markdown local) est disponible pour préparer un contenu à importer soi-même dans NotebookLM si tu le souhaites — aucun envoi automatique.

### ⚙️ Outils

- Agents planifiables qui exécutent une tâche récurrente et déposent leur résultat sous forme de neurone.
- Veille thématique et recherche web avec génération de synthèses.
- Module Professeur : parcours pédagogiques, répétition espacée, modèle IA dédié.
- Prompt Generator : aide à la rédaction de prompts avec sélection de provider/modèle.
- Import/analyse de CV (PDF) et génération de contenu pour candidature.
- **Navigateur configurable** : choix du navigateur utilisé pour ouvrir les liens externes depuis Docteur (détection des navigateurs réellement installés, ou chemin personnalisé), indépendant du navigateur affichant Docteur lui-même.
- **Sherlock OSINT** — 🧪 optionnel, non installé par défaut. Intégration de l'outil officiel [sherlock-project](https://github.com/sherlock-project/sherlock) (MIT) pour rechercher l'existence d'un nom d'utilisateur public sur des sites tiers — jamais de mot de passe, cookie, compte privé, force brute ni contournement d'authentification. Installation déclenchée uniquement par toi depuis le Studio Sherlock dédié ; les résultats sauvegardés en neurone sont privés/locaux par défaut. Voir [Studios](#-studios-metagpt-sherlock-investment-vidéo-cyber-audit).
- **Cyber Audit / SENTINEL** : audit de sécurité web externe, autorisé et non destructif (TLS, en-têtes, cookies, CORS, divulgation d'information), périmètre strict confirmé par toi, débit de requêtes réellement limité. Jamais d'exploitation, de brute force ni de scan de ports. Voir [Cyber Audit Studio](#cyber-audit-studio--sentinel).

### 🎥 Multimédia

- Résumé vidéo : téléchargement audio (yt-dlp), transcription (Whisper local ou Groq cloud), résumé.
- Analyse d'image 100 % locale via Ollama (`llava` par défaut), avec bascule OCR en cas de dépassement de délai.
- Reconnaissance de gestes par caméra — 🧪 expérimental.

## 🧠 Cortex Command Center

L'interface principale s'organise autour d'un noyau central (« Cortex », rendu en 3D/Three.js) qui reflète l'état courant du système (repos, écoute, réflexion, recherche, génération, erreur — toujours accompagné d'un texte, jamais uniquement d'une couleur).

- **Mode Focus** : le Cortex et la barre de commande occupent l'essentiel de l'écran, pour une utilisation concentrée.
- **Mode Dashboard** : les widgets des Studios (MetaGPT, Sherlock, Investment, Vidéo) et des connecteurs s'affichent autour du Cortex, avec un rail d'actions rapides, d'activité récente et le widget Cyber Audit (dernière mission, statut, nombre de constats).
- **Command Bar** : zone de saisie unique en bas d'écran pour interroger Docteur, avec retour vocal optionnel.

Détails techniques : `reports/CORTEX_COMMAND_CENTER_V2_2026-09.md`.

## 🧰 Studios (MetaGPT, Sherlock, Investment, Vidéo, Cyber Audit)

Cinq espaces de travail dédiés, accessibles depuis le Dashboard ou le Centre d'aide (`F1`).

### MetaGPT Studio

Assistant de planification et génération de code local (Ollama), organisé en pipeline explicite : **Brief → PRD/Design/Tasks → Génération de code texte → Diff → Approbation humaine → Application contrôlée**. Chaque étape affiche ses artefacts (documents de planification, fichiers générés, diff complet), les éventuels signalements de sécurité et demandes de dépendances détectées, ainsi qu'un historique des transitions.

> [!IMPORTANT]
> Pas de Terminal, pas de Bash, pas de Git autonome, pas d'accès Internet externe, pas d'exécution du code généré depuis l'interface. Aucune approbation ni application automatique : l'application d'un diff nécessite une approbation humaine explicite du hash exact et de la liste de fichiers, distincte de l'action d'application elle-même.

### Sherlock Studio

Recherche de la présence d'un pseudonyme public sur un nombre restreint de sites (3 par défaut), via une passerelle Docteur qui isole entièrement l'outil [sherlock-project](https://github.com/sherlock-project/sherlock) : réseau limité aux adresses publiques, système de fichiers cloisonné par recherche, code source figé par hash vérifié à chaque appel. Une recherche à la fois, 3 lancements par minute.

> [!NOTE]
> Isolation au niveau applicatif (réseau/filesystem/hash de code) : oui. Sandbox au niveau du système d'exploitation Windows : non — Sherlock s'exécute sous le même compte utilisateur que Docteur.

Aucun historique de recherches persistant à ce jour (les jobs vivent en mémoire le temps de la session du serveur backend).

### Investment Studio

Analyse financière et simulation — recherche de sources, saisie de données fondamentales, valorisation (multiples, DCF, reverse-DCF avec hypothèses toujours visibles), scoring transparent en 5 catégories (jamais une recommandation d'achat/vente), chronologie d'événements sourcés, et un **portefeuille simulé** (paper trading) avec suivi de performance (valeur de compte, P&L latent, allocation).

> [!IMPORTANT]
> Aucun broker réel, aucun ordre réel, aucune transaction réelle, aucune donnée de marché en temps réel. Toute action de portefeuille est explicitement marquée **PAPER** ; les tentatives d'action réelle (achat/vente/ordre réel) sont refusées par le serveur, pas seulement masquées côté interface.

### Studio Vidéo

Deux capacités distinctes, réunies dans un seul Studio à onglets :

- **Transcription** : résumé de vidéo longue (télécharge l'audio, transcrit, résume en texte) — ne produit jamais de fichier vidéo.
- **Rendu (MP4)** : génération locale d'un clip vidéo court (3 à 10 secondes) via un moteur Remotion local, avec aperçu du résultat.

Il n'existe pas aujourd'hui de montage multi-clips ni de ligne de temps éditable dans Docteur (le moteur de rendu local ne pilote qu'un modèle de clip fixe) ; cette page ne présente donc pas de fonctionnalité de « timeline » qui n'existerait pas réellement.

### Cyber Audit Studio — SENTINEL

Audit de sécurité web **externe, autorisé et non destructif** : TLS, en-têtes de sécurité, cookies, CORS, signaux de divulgation d'information, sur un périmètre (hôtes/ports/protocoles/chemins) explicitement déclaré et confirmé. Découverte de pages bornée au périmètre (liens réels trouvés dans les pages déjà autorisées, robots.txt et sitemap.xml quand ils sont autorisés — jamais de génération de chemins ni de brute force). Débit de requêtes **réellement limité** (rate limiting appliqué au trafic sortant, pas seulement une valeur affichée). Preuves et constats persistés (avec redaction systématique des secrets), rapport HTML exportable.

> [!IMPORTANT]
> Aucune exploitation, aucun brute force, aucun contournement d'authentification, aucun scan de ports, aucun déni de service, aucun shell, aucun outil offensif tiers (Nmap/Nuclei/SQLMap/Metasploit). Pas d'audit authentifié, pas de pentest complet. Re-scan/comparaison entre missions : non implémenté en V1. Export PDF : non implémenté (aucune dépendance lourde ajoutée pour cela).

Détails techniques complets : `reports/CYBER_AUDIT_AGENT_V1_2026-09.md`.

Détails techniques et matrice de capacités des 4 autres Studios : `reports/STUDIOS_UX_V2_2026-09.md`.

## 🏗️ Architecture

**Frontend** — React + TypeScript, servi par Vite. Communique avec le backend via une API HTTP locale (`http://localhost:3001` par défaut).

**Cortex Server** — Serveur Node.js (framework [Hono](https://hono.dev)), organisé en routes par fonctionnalité (neurones, recherche, vidéo, agents, MetaGPT, Sherlock, Investment, OpenMontage, connecteurs, etc.), chacune avec sa propre politique de sécurité (policy/gateway dédiée quand le module y touche à des ressources externes ou sensibles).

**Données** — SQLite (`better-sqlite3`) pour les neurones, réglages et journaux ; [LanceDB](https://lancedb.com/) pour l'index vectoriel utilisé par la recherche sémantique.

**IA** — Un routeur central (`router.js`) sélectionne un provider local ou cloud selon la configuration ; certaines fonctionnalités (veille, professeur) appellent directement un provider cloud spécifique plutôt que de passer par ce routeur (voir [Routage IA](#-routage-ia)).

```mermaid
flowchart LR
    UI[Frontend React / Vite]
    API[Cortex Server - Hono]
    ROUTER[Routeur IA]
    DB[(SQLite)]
    VEC[(LanceDB)]
    OLLAMA[Ollama - local]
    PAIR[PAIR - endpoint local ou distant]
    CLAUDE[Claude Code CLI]
    CODEX[Codex CLI]
    CLOUD[Providers cloud - Groq / Gemini / OpenRouter / Anthropic / OpenAI]
    FREELLM[FreeLLMAPI - instance externe optionnelle]

    UI --> API
    API --> DB
    API --> VEC
    API --> ROUTER
    ROUTER --> OLLAMA
    ROUTER --> PAIR
    ROUTER --> CLAUDE
    ROUTER --> CODEX
    ROUTER --> CLOUD
    ROUTER -.-> FREELLM
```

## 🤖 Providers IA

| Provider | Type | Auth | Usage |
|---|---|---|---|
| **Ollama** | Local | Aucune | Nécessite une installation séparée et au moins un modèle téléchargé |
| **Claude Code** | Abonnement (CLI) | Session officielle `claude` | ≠ Anthropic API — pas de clé requise en mode abonnement |
| **Codex** | Abonnement ChatGPT (CLI) | Session officielle `codex` | ≠ OpenAI API — pas de clé requise en mode abonnement |
| **Groq** | Cloud (API) | Clé API | |
| **Gemini** | Cloud (API) | Clé API | |
| **OpenRouter** | Cloud (API) | Clé API | |
| **Anthropic API** | Cloud (API, payant) | Clé API | Distinct de Claude Code |
| **OpenAI API** | Cloud (API, payant) | Clé API | Distinct de Codex |
| **FreeLLMAPI** | Cloud (API compatible OpenAI, optionnel) | Endpoint + clé selon l'instance | Instance à déployer séparément ; capacités limitées au texte (pas d'image/vidéo/audio) |
| **PAIR** (NVIDIA) | Endpoint distribué / local (optionnel) | Aucune (endpoint réseau) | Traité comme local par Docteur (alternative à Ollama) ; endpoint par défaut `localhost`, configurable vers une autre machine |

## 🧭 Routage IA

La majorité des fonctionnalités passent par un routeur central qui :

1. vérifie si le **mode Strict Local** est actif (dans ce cas, seul Ollama est utilisé) ;
2. sinon, tente le provider préféré configuré, puis bascule vers d'autres providers configurés en cas d'échec (clé invalide, service indisponible, quota dépassé) ;
3. revient à un modèle local en dernier recours si aucun provider cloud n'est disponible.

Certaines fonctionnalités (la veille/recherche et le module Professeur, par exemple) appellent directement un provider cloud plutôt que de passer par ce routeur central — chacune applique néanmoins sa propre vérification du mode Strict Local avant tout appel cloud. **Le projet ne prétend pas que 100 % des chemins passent par un unique routeur.**

## 🔒 Mode Strict Local

> [!IMPORTANT]
> Le mode Strict Local bloque les chemins cloud identifiés dans l'application. Il ne constitue pas une isolation réseau du système entier.

Quand ce mode est activé dans les réglages, Docteur bloque l'utilisation des providers cloud sur les chemins qui vérifient ce réglage (chat, veille, professeur, génération de prompts, comparaison de modèles, etc.) et retombe sur Ollama.

Ce mode dépend des modèles réellement installés en local : si Ollama n'a pas le modèle attendu, la fonctionnalité concernée peut devenir indisponible plutôt que de basculer silencieusement vers le cloud.

## 🚀 Installation détaillée

### Prérequis obligatoires

- Windows (plateforme principale visée par les scripts fournis)
- [Node.js](https://nodejs.org/) ≥ 20
- npm

### Prérequis optionnels (selon les fonctionnalités souhaitées)

- [Ollama](https://ollama.com) — pour le chat, la vision et la recherche 100 % locaux
- [Claude Code CLI](https://github.com/anthropics/claude-code) — pour utiliser Claude via ton abonnement
- [Codex CLI](https://github.com/openai/codex) — pour utiliser Codex via ton abonnement ChatGPT
- `ffmpeg` — pour le découpage audio (transcription vidéo)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) — pour le téléchargement audio des vidéos à résumer
- Une caméra — pour la fonctionnalité expérimentale de gestes
- Des clés API — pour Groq, Gemini, OpenRouter, Anthropic API, OpenAI API si tu veux les utiliser
- Une instance FreeLLMAPI et/ou un endpoint PAIR déjà déployés, si tu veux les configurer

### Frontend et backend

```powershell
git clone https://github.com/FloW1772/Docteur.git
cd Docteur
npm install
cd cortex-server
npm install
```

### Démarrage manuel (mode développement)

Dans un premier terminal, démarre le backend :

```powershell
cd cortex-server
npm run dev
```

Dans un second terminal, démarre le frontend :

```powershell
npm run dev
```

L'interface est ensuite disponible sur `http://localhost:5173`, et communique avec le backend sur `http://localhost:3001`.

### Launcher Windows

Le dépôt fournit un launcher Windows (`Docteur-Launcher.bat`) qui propose plusieurs modes (usage local, accès réseau, mode mobile/PWA) et démarre l'ensemble (backend + frontend) sans lancer les commandes manuellement.

> [!NOTE]
> Le launcher peut nécessiter d'adapter son chemin de projet si le dépôt n'est pas installé à l'emplacement prévu.

### Build

```powershell
npm run build
```

Compile le TypeScript et génère les fichiers de production dans `dist/`.

## ⚙️ Configuration des IA

La configuration des providers (clés API, endpoints, mode Strict Local, choix du modèle par fonctionnalité) se fait depuis l'écran **Réglages** de l'interface, une fois Docteur lancé — aucune clé n'est à écrire dans un fichier de configuration à la main.

### Ollama

Installe Ollama séparément, puis télécharge au moins un modèle de ton choix (`ollama pull <modèle>`). Docteur ne télécharge aucun modèle automatiquement à ta place. Aucune clé API n'est nécessaire.

### Claude Code

```powershell
npm install -g @anthropic-ai/claude-code
claude
```

La commande `claude` ouvre le flux de connexion officiel Anthropic. Docteur utilise ensuite la session CLI déjà ouverte — aucune clé `ANTHROPIC_API_KEY` n'est nécessaire en mode abonnement, et Docteur ne récupère ni ne stocke ton mot de passe. L'API Anthropic classique (payante, par clé) reste un mode séparé et distinct.

### Codex

```powershell
npm install -g @openai/codex
codex
```

La commande `codex` ouvre le flux de connexion officiel OpenAI/ChatGPT. Aucune clé `OPENAI_API_KEY` n'est nécessaire en mode abonnement. L'API OpenAI classique (payante, par clé) reste un mode séparé.

### FreeLLMAPI

Provider optionnel, compatible avec l'API OpenAI. Nécessite une instance FreeLLMAPI que tu déploies et exposes toi-même, puis son endpoint (et sa clé le cas échéant) sont à renseigner dans les réglages Docteur. La liste des modèles disponibles peut être découverte automatiquement selon ce que l'instance expose.

### Clés API

Certains providers (Groq, Gemini, OpenRouter, Anthropic API, OpenAI API) nécessitent une clé fournie par toi. Elle se configure depuis les réglages Docteur — jamais en clair dans un fichier du dépôt :

```text
YOUR_API_KEY
```

## 💾 Données et stockage

- Les neurones, réglages et journaux d'activité sont stockés dans une base SQLite locale (mode WAL activé).
- L'index de recherche sémantique est stocké dans LanceDB, également en local.
- Les clés API cloud sont chiffrées avant d'être écrites en base.
- Un mécanisme de sauvegarde/restauration (backup) est disponible depuis l'interface.

Aucun chemin ni identifiant personnel n'est indiqué ici : l'emplacement exact des données dépend de ton installation.

## 🛡️ Sécurité et confidentialité

- Le backend écoute sur `127.0.0.1` par défaut (pas d'exposition réseau sans configuration explicite).
- CORS restrictif avec validation d'Origin, limité aux origines de développement attendues.
- Protection contre les requêtes SSRF sur les URLs traitées côté serveur (blocage des adresses locales/privées).
- Les clés API sont chiffrées via DPAPI Windows avant stockage — jamais en clair, jamais exposées au frontend.
- Les journaux (logs) masquent automatiquement les clés et tokens détectés.
- Les appels aux CLI Claude Code et Codex, à Sherlock OSINT et à la sélection de navigateur se font sans interprétation shell des arguments dynamiques (`shell:false` systématique).
- Contrôle de taille et de format sur les fichiers importés.
- Chaque Studio à risque applique sa propre politique dédiée plutôt qu'un contrôle générique : MetaGPT n'applique jamais un diff sans approbation humaine explicite du hash et de la liste de fichiers exacts (aucune application automatique) ; Sherlock isole réseau/filesystem et vérifie le hash du code source à chaque appel ; Investment refuse au niveau serveur toute action qui ne serait pas explicitement marquée `PAPER_BUY`/`PAPER_SELL` (aucun ordre réel possible même en contournant l'interface).

### Verrou de confidentialité (`egress_policy`)

Toute donnée dérivée d'une source marquée privée (neurone verrouillé, CV/candidature, contenu synchronisé OneDrive/YouTube, résultat OSINT) porte une politique de sortie `local_only`, qui se propage automatiquement à tout ce qui en dérive (résumé, mémoire adaptative, Notebook) — impossible de repasser cette donnée en `cloud_allowed` sans retirer la source responsable. Un garde-fou (`guardCloudCall`) bloque toute tentative d'appel cloud avec du contenu marqué privé, appliqué directement à la frontière de chaque provider cloud plutôt que dans l'interface uniquement — un contournement au niveau du routeur ne suffit pas à passer outre. Testé explicitement : aucun provider cloud (Gemini, Groq, OpenRouter, OpenAI, Anthropic, FreeLLMAPI, Claude Code, Codex) ne peut recevoir de contenu privé, y compris via une chaîne de fallback (un cloud bloqué n'essaie jamais un autre cloud pour le même contenu). Le repli vers Ollama local reste toujours autorisé.

Paramètres → Confidentialité propose un test d'étanchéité synthétique (aucune vraie donnée envoyée) qui vérifie ce comportement à la demande.

> [!IMPORTANT]
> Docteur considère la session Windows courante comme un environnement de confiance.

**L'authentification d'un processus local arbitraire n'est pas prise en charge** : un programme malveillant exécuté sous le même compte Windows que Docteur sort du modèle de menace actuel (comme pour la base SQLite ou les clés chiffrées, qui restent lisibles par tout processus tournant sous ce même compte).

## 📁 Formats supportés

| Format | Support |
|---|---|
| `.xlsx` | ✅ |
| `.csv` | ✅ |
| `.txt` / `.md` / `.json` | ✅ |
| PDF | ✅ limité aux fonctions documentées (import/analyse de CV, export de neurones) |
| `.xls` (ancien format Excel) | ❌ |

Il n'y a pas d'import PDF générique dans le corpus documentaire à ce jour. Le format legacy `.xls` n'est plus accepté (dépendance associée retirée pour des raisons de sécurité) — convertis le fichier en `.xlsx` ou `.csv` avant import.

## 🎥 Vidéo et transcription

Pipeline simplifié :

```text
URL vidéo → téléchargement audio (yt-dlp) → découpage (ffmpeg) → transcription (Whisper local ou Groq) → résumé
```

Le temps de traitement dépend de la durée de la vidéo. Certaines plateformes peuvent bloquer le téléchargement (erreurs 403) ; Docteur n'utilise pas de cookies de navigateur pour contourner ce type de blocage.

## ✋ Caméra et gestes

🧪 **Fonction expérimentale.** La reconnaissance de gestes de la main (via la caméra du navigateur, basée sur MediaPipe) sert à naviguer entre les neurones sans clavier ni souris. La fiabilité dépend de l'éclairage, de la position de la main devant la caméra et des performances de la machine.

## 📚 RAG et documents

Docteur peut retrouver des éléments pertinents dans les connaissances déjà stockées (neurones, documents importés) afin de les ajouter au contexte envoyé au modèle IA, plutôt que de se limiter à ce que tu écris dans ta question. Cette recherche s'appuie sur des embeddings calculés localement via Ollama et un index vectoriel LanceDB.

## 📓 Notebook local

Un Notebook regroupe des sources déjà existantes dans Docteur (neurones) sans jamais les dupliquer — ajouter une source à un Notebook crée uniquement une référence, jamais une copie de l'embedding. La recherche pour répondre à une question est limitée exclusivement aux sources du Notebook consulté (jamais à l'ensemble de la base), et chaque citation renvoyée correspond à un extrait réellement retrouvé — aucune référence n'est inventée.

- **Toujours local** : le module Notebook n'importe aucun provider cloud dans son code — il n'existe littéralement aucun chemin possible vers un appel cloud depuis ce module, indépendamment de tes réglages.
- **Confidentialité héritée automatiquement** : un Notebook adopte le niveau de confidentialité le plus restrictif de ses sources — ajouter une seule source privée (CV, contenu synchronisé marqué privé) rend tout le Notebook local uniquement, de façon irréversible tant que cette source n'est pas retirée.
- Supprimer une source d'un Notebook, ou supprimer le Notebook lui-même, ne supprime jamais les neurones sous-jacents.
- **Fonctionnalités disponibles actuellement** : résumé global, questions/réponses avec citations.
- **Non encore implémenté** (annoncé honnêtement dans l'interface plutôt que simulé) : points clés, FAQ, fiche d'étude, flashcards, chronologie, glossaire, comparaison de sources, résumés par thème.

## ✅ Tests et qualité

État constaté à la dernière vérification (suites isolées, sans appel réseau ni donnée réelle) :

| Vérification | Résultat |
|---|---|
| Tests standards | ✅ 232 / 232 |
| Build (`tsc && vite build`) | ✅ |
| TypeScript (`tsc --noEmit`) | ✅ 0 erreur |
| Appels cloud pendant les tests standards | ✅ 0 |
| Couverture end-to-end | 🚧 Partielle |

Les suites couvrent notamment : fallback/routage IA, providers, résolution sécurisée des CLI Codex/Claude, mode Strict Local, import de fichiers, agents externes, FreeLLMAPI, transcription vidéo, verrou de confidentialité/egress (certification dédiée), connecteurs OAuth (mocks), mémoire adaptative, Notebook local (retrieval scopé, citations), NotebookLM (zéro appel réseau certifié), navigateur configurable (validation d'URL, injection), Sherlock OSINT (validation d'entrée, `shell:false`). Certaines suites end-to-end (navigateur, serveur de développement déjà lancé) ne sont pas exécutées automatiquement et nécessitent un environnement complet.

Côté frontend, le Cortex Command Center et les quatre Studios disposent chacun de leur propre suite de tests navigateur Playwright isolée (`scripts/test-*-browser.mjs`, données mockées via `page.route`, jamais d'appel au serveur réel) — détails dans `reports/CORTEX_COMMAND_CENTER_V2_2026-09.md` et `reports/STUDIOS_UX_V2_2026-09.md`.

Les tests unitaires/intégration ne remplacent pas une validation end-to-end complète.

## 📁 Structure du projet

```text
Docteur/
├── src/                     # Frontend React/TypeScript
│   ├── components/
│   ├── hooks/
│   └── lib/
│
├── cortex-server/           # Backend Node.js (Hono)
│   ├── src/
│   │   ├── lib/             # Providers IA, SQLite, LanceDB, sécurité...
│   │   └── routes/          # Une route par fonctionnalité
│   └── test-*.mjs           # Suites de tests isolées
│
├── reports/                 # Rapports d'audit et de phase (voir mission MASTER)
├── Docteur-Launcher.bat     # Lanceur Windows (menu interactif)
├── package.json
└── README.md
```

## 🧰 Commandes utiles

Frontend (racine du dépôt) :

```powershell
npm run dev              # Démarrage en mode développement
npm run dev:local        # Démarrage avec accès réseau local
npm run build             # Build de production
npm run preview           # Prévisualiser le build
```

Backend (`cortex-server/`) :

```powershell
npm run dev               # Démarrage en développement (redémarrage auto)
npm run start              # Démarrage simple
npm run check              # Vérification de démarrage du serveur
```

## 🩺 Dépannage

### `ERR_CONNECTION_REFUSED` sur le frontend

Vérifie que `cortex-server` est bien démarré (`npm run dev` dans `cortex-server/`) et qu'il écoute sur le port 3001.

### Ollama non disponible

Vérifie que le service Ollama tourne, et que le modèle attendu est bien installé (`ollama list`).

### Claude Code non détecté

```powershell
where.exe claude
claude --version
```

### Codex non détecté

```powershell
where.exe codex
codex --version
```

### Problèmes avec une vidéo (yt-dlp)

Certaines plateformes peuvent bloquer le téléchargement. Vérifie que `yt-dlp` est à jour. Docteur n'utilise pas et ne doit pas utiliser de cookies extraits d'un navigateur pour contourner ces blocages.

### FreeLLMAPI « non configuré »

Ce message signifie qu'aucun endpoint valide n'a été renseigné dans les réglages, ou que l'instance FreeLLMAPI n'est pas joignable. Une instance réelle doit être déployée séparément avant configuration.

## 🚦 État du projet

| Composant | État |
|---|---|
| Neurones | ✅ |
| Chat local | ✅ |
| RAG | ✅ |
| Notebook local (résumé + questions/réponses avec citations) | ✅ |
| Notebook — outils avancés (FAQ, flashcards, chronologie, etc.) | 🚧 non implémenté |
| Mémoire adaptative locale | ✅ |
| Vidéo / transcription | ✅ |
| Providers multiples | ✅ |
| Verrou de confidentialité (`egress_policy` / local_only) | ✅ certifié par tests |
| Strict Local | ✅ |
| Free AI Finder | ✅ |
| NotebookLM (Google) | ⚙️ préparation uniquement, aucun appel actif |
| Connecteurs YouTube / OneDrive | 🚧 backend prêt, aucune UI, aucun compte réel testé |
| Navigateur configurable | ✅ |
| Cortex Command Center (Focus/Dashboard, widgets, Command Bar) | ✅ |
| MetaGPT Studio (planification, code texte, diff, approbation humaine) | ✅ |
| Sherlock OSINT / Studio dédié | 🧪 optionnel, non installé par défaut, pas d'historique persistant |
| Investment Studio (fondamentaux, valorisation, scoring, paper trading) | ✅ analyse/simulation uniquement |
| Studio Vidéo — transcription | ✅ |
| Studio Vidéo — rendu MP4 local | ✅ un seul modèle de clip, pas de montage multi-clips |
| Cyber Audit Studio / SENTINEL (audit externe non destructif) | ✅ pas de re-scan/comparaison, pas d'export PDF |
| Entraînement local (LoRA/QLoRA) | 📋 étudié, non implémenté (voir `reports/`) |
| Gestes caméra | 🧪 |
| FreeLLMAPI | ⚙️ nécessite configuration |
| PAIR | ⚙️ nécessite endpoint |
| End-to-end complet | 🚧 |

Docteur est un projet personnel activement développé — il n'est pas présenté comme « production ready » au sens d'un logiciel distribué à grande échelle.

## ⚠️ Limitations connues

- Le format `.xls` (Excel legacy) n'est plus supporté.
- FreeLLMAPI et PAIR nécessitent chacun une instance/un endpoint externes déjà déployés — ils ne fonctionnent pas « out of the box ».
- Plusieurs providers cloud nécessitent une clé API fournie par l'utilisateur.
- La reconnaissance de gestes par caméra reste expérimentale et sensible aux conditions d'utilisation.
- L'authentification d'un processus local arbitraire n'est pas prise en charge (voir [Sécurité et confidentialité](#-sécurité-et-confidentialité)).
- Certaines suites de tests end-to-end nécessitent un environnement de développement complet et ne sont pas exécutées automatiquement.
- **Connecteurs YouTube et OneDrive** : le backend (OAuth, synchronisation, déduplication, stockage sécurisé) est implémenté et testé, mais **aucune interface de connexion n'est encore disponible dans les Paramètres**, et aucun compte réel n'a été testé (nécessite des identifiants d'application Google Cloud / Azure fournis par l'utilisateur). L'API officielle YouTube ne permet pas d'accéder à l'historique de visionnage complet (limitation de Google, pas de contournement prévu). OneDrive : formats réellement importables limités à `.md`, `.txt`, `.pdf`, `.xlsx` (pas `.docx`, aucune dépendance de lecture pour ce format actuellement).
- **NotebookLM (Google)** : uniquement une préparation d'architecture. Une clé API peut être enregistrée, mais aucun appel réel n'est jamais déclenché — c'est un espace réservé pour une intégration future, pas une fonctionnalité active.
- **Cyber Audit Studio / SENTINEL** : pas de pentest complet, pas d'exploitation, pas d'audit authentifié, pas de scan de ports, pas d'outils offensifs automatiques. Re-scan/comparaison entre missions non implémenté. Export PDF non implémenté (aucune dépendance lourde ajoutée pour cela). L'absence de constat détecté ne signifie pas absence de vulnérabilité.
- **Notebook local** : seuls le résumé global et les questions/réponses avec citations sont disponibles. Points clés, FAQ, fiche d'étude, flashcards, chronologie, glossaire et comparaison de sources ne sont pas implémentés.
- **Sherlock OSINT** : outil tiers optionnel (non développé par Docteur), à installer explicitement depuis le Studio Sherlock dédié — recherche par nom d'utilisateur public uniquement, aucun historique de recherches persistant (les jobs vivent en mémoire le temps de la session serveur).
- **Entraînement local (LoRA/QLoRA)** : étudié (voir `reports/MASTER_PHASE_8_TRAINING_FEASIBILITY.md`) mais non implémenté — le RAG et la mémoire adaptative existants couvrent mieux les besoins identifiés que ne le ferait un fine-tuning sur le matériel typique visé par Docteur.

## 🗺️ Roadmap

Pistes d'amélioration identifiées, sans garantie ni date :

- Étoffer la couverture de tests end-to-end (navigateur, serveur réel).
- Optimiser le chargement pour de très grands volumes de neurones.
- Améliorer la fiabilité de la reconnaissance de gestes.
- Ajouter ou affiner le support d'autres providers IA.
- Poursuivre le durcissement sécurité côté Windows.

## 🤝 Contribuer

Le dépôt ne contient pas encore de guide de contribution dédié. Pour proposer une modification :

1. Fork du dépôt.
2. Crée une branche dédiée à ta modification.
3. Fais un changement ciblé et cohérent.
4. Lance les tests concernés (`node --test <fichier>` dans `cortex-server/`, `npm run build` à la racine).
5. Ouvre une Pull Request avec une description claire.

## 🔐 Signaler un problème de sécurité

Le dépôt ne contient pas encore de fichier `SECURITY.md` dédié. Si tu identifies une vulnérabilité, merci de ne jamais la publier avec des secrets, tokens ou données personnelles, et de contacter le mainteneur du dépôt directement plutôt que d'ouvrir une issue publique détaillée.

## 📜 Licence

> Le dépôt ne contient actuellement pas de licence explicite. En l'absence de licence, aucun droit de réutilisation n'est accordé automatiquement.

## ❤️ Technologies principales

React · TypeScript · Vite · Node.js · Hono · SQLite (better-sqlite3) · LanceDB · Ollama · Pino

---

Docteur est construit autour d'une idée simple : laisser l'utilisateur choisir où ses données sont traitées et quels modèles il souhaite utiliser.
