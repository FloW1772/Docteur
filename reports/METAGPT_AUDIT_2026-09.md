# METAGPT — AUDIT AVANT INSTALLATION (Phase MG-1)

Date : 2026-09-17
Méthode : audit distant en lecture seule (web/API GitHub), aucun clone, aucune installation, aucune modification de Docteur.

## 1. Dépôt canonique

`FoundationAgents/MetaGPT` — confirmé indépendamment (pas supposé). `geekan/MetaGPT` renvoie un HTTP 301 vers ce dépôt : c'est un vrai transfert d'organisation GitHub (même `id` de repo), pas un fork ni un piège. Branche par défaut `main`, créé 2023-06-30, 6 367 commits, dernier push 2026-01-21 (signé GPG, vérifié) — **aucune activité depuis ~8 mois**. 70 459 stars, 8 950 forks, 132 issues ouvertes. Aucun clone/typosquat suspect trouvé (`franztao/MetaGPT` est un fork ordinaire, pas une usurpation).

## SHA recommandé

Pas de release stable récente formellement taguée au-delà de v0.8.x, alors que `main` déclare déjà `version="1.0.0"` dans `setup.py` — `main` a divergé au-delà du dernier tag stable. **Recommandation : épingler un SHA précis sur `main` au moment de l'installation (jamais suivre `main` en continu), à défaut d'un tag 1.0.0 stable.**

## 2. Licence

MIT, texte standard, aucune clause de brevet ni de marque. Lecture pratique (pas un avis juridique définitif) :
- **Processus externe isolé (subprocess, pas de code lié)** : aucune obligation au-delà de ne pas usurper la paternité.
- **Adapter qui importe/embarque le code MetaGPT** : conserver la notice de copyright/licence dans le code redistribué.
- **Modification du code source de MetaGPT** : toujours MIT — aucune obligation de publier les modifications.

## 3. Python

```
Python min : >=3.9
Python max : <3.12
Version réellement recommandée par le projet : 3.9 UNIQUEMENT
```
**Point important** : le README/setup.py annoncent 3.9–3.11, mais la CI réelle (`.github/workflows/unittest.yaml`/`fulltest.yaml`) a sa matrice 3.10/3.11 **commentée** — seul 3.9 est effectivement testé par l'automatisation du projet. 3.10/3.11 sont non vérifiés par CI, à traiter comme "devrait marcher" et non "prouvé".

Python disponibles localement (vérifié, aucun venv créé) : 3.10.11 et 3.14. **Aucun 3.9 disponible localement** — à installer si l'on veut coller exactement à la version testée par la CI du projet.

## 4. Node / pnpm — Mermaid

```python
class InstallMermaidCLI(Command):
    def run(self):
        subprocess.check_call(["npm", "install", "-g", "@mermaid-js/mermaid-cli"])
```
Commande setuptools **séparée et non branchée sur le cycle de vie `install`** — confirmé qu'un `pip install .` normal **ne la déclenche pas automatiquement** ; elle ne s'exécute que sur invocation explicite `python setup.py install_mermaid`. Si jamais invoquée, elle installe bien en **portée globale npm** (`-g`), hors de tout venv — à ne jamais autoriser dans l'intégration Docteur. Usage réel de Node : rendu de diagrammes Mermaid uniquement (convenience documentaire), aucune dépendance Node pour l'exécution multi-agent cœur.

## 5. Install scripts / side effects

- Aucun hook preinstall/postinstall npm-style (pas de `package.json` racine).
- `Dockerfile` : construit une image avec Chromium + mermaid-cli, mais ne s'exécute jamais automatiquement — seulement sur `docker build`/`docker run` explicite.
- `subprocess`/`os.system` : présents en usage **runtime** (pas install-time) dans `metagpt/tools/libs/shell.py` et `metagpt/tools/libs/terminal.py` — ce dernier lance un **vrai shell persistant** (`bash`/`cmd.exe`) avec **environnement hérité complet** (`env=os.environ.copy()`) et une denylist de seulement deux sous-chaînes (`"run dev"`, `"serve "`). C'est une injection de commande par conception (CWE-78), confirmée par l'issue externe #1931.
- `eval()`/`exec()` sur du texte potentiellement généré par LLM, sans sandbox réelle : `metagpt/utils/serialize.py` (`eval(value)`) et `metagpt/ext/aflow/scripts/operator.py` (`exec(code, ...)` avec blocklist incomplète, connue pour être contournable).
- **`git init`/`git add`/`git commit` automatiques et inconditionnels** dès qu'un `GitRepository`/`ProjectRepo` est ouvert sur un dossier non-git (`metagpt/utils/git_repository.py::_init()`). Une méthode `push()` shellant `git push` existe et est appelable (non auto-invoquée dans les chemins inspectés, mais présente).

## 6. Requirements

**CORE** : openai, anthropic, google-generativeai, aiohttp, faiss_cpu, qdrant-client, lancedb (vector DB — core, pas optionnel), gitpython, redis, websockets, **playwright** (automatisation navigateur — **core, pas optionnel**), networkx, pygithub, semantic-kernel, boto3, ipykernel/nbclient/nbformat (pile Jupyter — core).

**OPTIONAL/EXTRAS** : selenium (`selenium` extra), RAG (~17 paquets llama-index), pyppeteer (non maintenu, signalé dans les commentaires du projet lui-même), **torch/transformers/tensorflow** (uniquement dans l'extra `android_assistant`, non installés par défaut).

**DEV** : pylint, black, isort, pre-commit.

Aucun chromadb/milvus/pinecone/neo4j/docker-SDK/gradio trouvé. faiss_cpu, qdrant-client et lancedb sont déjà des dépendances vectorielles **core**.

## 7. LLM providers

27 providers codés (`metagpt/configs/llm_config.py`), y compris OpenAI, Anthropic, Azure, Gemini, Ollama (3 variantes), OpenRouter, Bedrock, DeepSeek, etc. Groq n'a pas de classe dédiée — passe uniquement par le chemin générique OpenAI-compatible (`base_url` override).

**Ollama** : implémentation réelle et fonctionnelle (`metagpt/provider/ollama_api.py`), requêtes HTTP brutes (pas le SDK OpenAI), parsing propre (streaming, `prompt_eval_count`). Mais `openai_api.py` gère le **tool-calling natif** (`message.tool_calls[0].function.arguments`) que l'implémentation Ollama n'a pas — les modes agentiques avancés (ex: sélection d'action structurée de RoleZero) reposent sur ce contrat OpenAI-style.

```
LOCAL ONLY POSSIBLE : PARTIEL
```
Les workflows SOP simples (parsing texte/JSON) devraient fonctionner intégralement en local via Ollama ; les workflows dépendant du function-calling natif dégradent ou échouent sans émulation JSON supplémentaire.

## 8. Configuration / secrets

Chemin par défaut : `~/.metagpt/config2.yaml` (`CONFIG_ROOT = Path.home() / ".metagpt"`). Ordre de fusion réel (contre-intuitif) :
```python
dicts = [dict(os.environ), *(Config.read_yaml(path) for path in default_config_paths), kwargs]
```
**Les fichiers YAML écrasent les variables d'environnement**, pas l'inverse — à connaître pour la conception de l'adapter.

Champs sensibles dans le template : `api_key`, `base_url`, `proxy`, par provider et par rôle.

**Chemin sûr confirmé pour Docteur** : `Config.from_llm_config(llm_config: dict)` permet de construire une config entièrement en mémoire (dict Python + variables d'env), **sans jamais écrire dans `~/.metagpt`**. C'est la voie d'intégration à utiliser — aucune clé Docteur ne doit transiter par ce fichier.

Aucun code trouvé qui logue l'objet `Config`/`LLMConfig` complet (donc pas de fuite directe de `api_key` par ce biais dans les fichiers inspectés) — mais recherche non exhaustive sur l'ensemble du dépôt (API de recherche de code GitHub nécessitant une authentification, non utilisée ici).

## 9. Filesystem

`DEFAULT_WORKSPACE_ROOT = METAGPT_ROOT / "workspace"` (dans l'arbre du package MetaGPT lui-même). `WorkspaceConfig` crée le dossier automatiquement à l'instanciation (`mkdir(parents=True, exist_ok=True)`).

**Risque réel de traversal** : `metagpt/actions/prepare_documents.py::_init_repo()` construit un chemin via `Path(self.config.workspace.path) / name` où `name` provient de `project_name`, potentiellement dérivé d'une entrée utilisateur non fiable ("Original Requirement"), **sans sanitisation** contre `..` ou caractères spéciaux. Pire : si le dossier cible existe déjà, `shutil.rmtree(path)` est appelé sans confirmation. `config.project_path` peut aussi être un chemin absolu fourni directement, contournant totalement `workspace.path`.

**Git automatique confirmé** (voir section 5) — comportement par défaut, pas optionnel.

## 10. Exécution de code — classification

| Capacité | Fichier | Classe | À désactiver en 1ère intégration ? |
|---|---|---|---|
| Exécution notebook (DataInterpreter) | `metagpt/actions/di/execute_nb_code.py` | CODE_EXECUTION | Oui — aucune sandbox native (pas de Docker, pas de limites ressources) |
| Outil Bash/Terminal | `metagpt/tools/libs/terminal.py` | SYSTEM_EXECUTION | **Oui, priorité maximale** — shell persistant, env hérité complet, denylist de 2 substrings |
| Automatisation navigateur (Playwright) | `metagpt/tools/libs/browser.py` | SYSTEM_EXECUTION | Oui, sauf egress réseau restreint |
| `eval()` désérialisation messages | `metagpt/utils/serialize.py` | CODE_EXECUTION (latent) | Traiter tout message inter-agents comme non fiable |
| `exec()` module aflow | `metagpt/ext/aflow/scripts/operator.py` | CODE_EXECUTION | Oui — ne pas utiliser le module aflow du tout |
| Création PR/issue Git | `metagpt/tools/libs/git.py` | WORKSPACE_WRITE (externe, atteint GitHub) | Désactiver sauf credentials scopées |
| `git init/add/commit` automatique | `metagpt/utils/git_repository.py` | WORKSPACE_WRITE (automatique, non opt-in) | **Oui — comportement par défaut à neutraliser explicitement** |

## 11. Réseau

- **LLM providers** (attendu) : openai, anthropic, zhipuai, google-generativeai, qianfan, dashscope, volcengine, spark_ai_python.
- **Recherche** (attendu, optionnel) : SerpAPI, Serper (défaut), Google Custom Search, DuckDuckGo (seul sans clé), Bing — inactif tant que non configuré.
- **Navigateur** (attendu, optionnel, risque élevé) : Playwright — l'agent choisit lui-même les URL visitées, même classe de risque que le SSRF confirmé (section 16).
- **Téléchargements paquets** : aucune preuve d'appel runtime vers PyPI/npm au-delà de l'installation.
- **Télémétrie/analytics** : **aucune trouvée** — absence confirmée sur `requirements.txt` complet (71 lignes) et fichiers de config/provider/logging inspectés. Recherche non exhaustive sur l'intégralité du dépôt (API de recherche de code GitHub nécessitant authentification).
- **Vérification de mise à jour au démarrage** : aucune trouvée.

## 12. Credentials

Aucun code trouvé qui logue l'objet `Config`/`LLMConfig` complet ni qui sérialise `os.environ` complet vers un log ou un réseau. Les logs (loguru) écrivent dans `METAGPT_ROOT/logs/`, à l'intérieur de l'arbre du package — pas un emplacement partagé. Recherche non exhaustive sur l'ensemble du dépôt (mêmes limites d'accès à l'API de recherche GitHub).

## 16. SECURITY.md / CVE — SECTION CRITIQUE

`SECURITY.md` existe mais est minimal : contact email unique (`alexanderwu@deepwisdom.ai`), **aucune version actuellement marquée comme supportée** (0.6.x, 0.7.x, <0.6.x tous ❌), aucun SLA de divulgation.

**4 CVE réelles et vérifiées, confirmées présentes sur `main` actuellement (pas corrigées) :**

| CVE | Description | Fichier | Statut |
|---|---|---|---|
| CVE-2026-5971 | Injection de code via `eval()` dans `ActionNode.xml_fill` | `metagpt/actions/action_node.py` | Non corrigé |
| CVE-2026-6111 | SSRF dans `decode_image` (validation faible, préfixe "http" seulement) | `metagpt/utils/common.py` | **Vérifié présent sur main**, fix en PR #1941 **non mergée** |
| CVE-2026-11455 | Injection de commande via `os.system("where " + command)` sur config mermaid.path | `check_cmd_exists` | **Vérifié présent sur main**, fix en PR #2067 **non mergée** |
| CVE-2026-6110 | Injection de code dans `generate_thoughts` (Tree-of-Thought) | `metagpt/strategy/tot.py` | Référencé, non vérifié source par source |

D'autres CVE mentionnées par des agrégateurs tiers (CVE-2026-5970, -5973, -19060, -0760) n'ont pas pu être recoupées indépendamment avec des issues/PR GitHub réelles dans le temps imparti — traitées comme non confirmées, ni comme fausses.

**CVE de dépendances** : non auditées dans cette passe (recommandé : `pip-audit`/OSV avant toute installation — plusieurs versions figées comme `aiohttp==3.8.6` sont anciennes).

## 17. Score de risque

```
RISQUE SUPPLY-CHAIN : MOYEN
Dépôt légitime et actif historiquement, mais activité stoppée depuis ~8 mois,
aucune version formellement supportée par SECURITY.md, dépendances lourdes
(playwright core) non optionnelles.

RISQUE EXÉCUTION : ÉLEVÉ
Outil Bash/Terminal quasi-libre (denylist de 2 substrings, env hérité complet),
eval()/exec() non sandboxés sur entrée LLM, 3 CVE d'exécution de code
confirmées non corrigées sur main (dont 2 avec PR de fix encore ouvertes),
aucune sandbox native (pas de Docker/conteneur par défaut).

RISQUE CREDENTIALS : MOYEN
Pas de fuite directe trouvée dans les chemins inspectés, mais recherche non
exhaustive (limites API GitHub). Ordre de fusion de config contre-intuitif
(YAML écrase les env vars) à bien maîtriser côté adapter.

RISQUE FILESYSTEM : ÉLEVÉ
git init/add/commit AUTOMATIQUE et non opt-in sur toute ouverture de
GitRepository ; path traversal non sanitisé sur project_name avec
shutil.rmtree() possible sans confirmation.

RISQUE CLOUD : FAIBLE À MOYEN
Fonctionnement local partiellement possible (Ollama), mais les modes
agentiques avancés dépendent du tool-calling natif OpenAI-style, non
répliqué par le provider Ollama.
```

## 18. Architecture proposée (si intégration confirmée plus tard)

```
C:\dev\Docteur\external\MetaGPT           (SHA épinglé, jamais main flottant)
C:\dev\Docteur\external\MetaGPT\.venv     (Python 3.9, isolé, séparé du venv OpenMontage)
C:\dev\Docteur\cortex-server\data\metagpt-workspaces\<job-id>
MetaGPTAdapter (Node) → subprocess isolé, Config.from_llm_config() en mémoire uniquement
```
Aucun accès direct au repo principal Docteur. Compte tenu du risque ÉLEVÉ en exécution et filesystem, l'adapter devra **désactiver explicitement** : l'outil Terminal/Bash, le module aflow, l'exécution de notebook DataInterpreter (ou l'isoler dans un conteneur séparé sans montage hôte), et neutraliser le comportement `git init/add/commit` automatique (soit en interceptant l'appel, soit en pointant `GitRepository` vers un dossier jetable détruit après chaque job).

## 19. Premier périmètre fonctionnel proposé

Autorisé : créer une spécification, proposer une architecture, produire un plan projet, auditer un workspace, générer un prototype sandboxé (texte/code généré mais non exécuté).
Interdit en phase 1 : édition directe de Docteur, git commit/push, installation de package automatique, exécution système libre (Terminal/Bash), navigateur, DataInterpreter/notebook.

---

# METAGPT — AUDIT AVANT INSTALLATION

```
Dépôt canonique :
FoundationAgents/MetaGPT (https://github.com/FoundationAgents/MetaGPT) — confirmé,
transfert légitime depuis geekan/MetaGPT

SHA recommandé :
Épingler un commit précis sur main (pas de tag stable 1.0.0 encore publié) —
SHA exact à déterminer au moment de l'approbation d'installation

Licence :
MIT — aucune obligation forte pour un processus externe isolé

Python :
>=3.9,<3.12 déclaré ; SEUL 3.9 réellement testé par la CI du projet

Node/pnpm :
Requis uniquement pour Mermaid CLI (optionnel, install manuelle globale
jamais déclenchée automatiquement par pip install)

Installation globale requise :
NON (par défaut) — OUI seulement si install_mermaid explicitement invoqué (à interdire)

Mermaid global install :
Confirmé non-automatique ; si utilisé, installe en portée npm globale (à proscrire)

Provider local possible :
OUI (Ollama implémenté et fonctionnel pour chat simple)

Ollama possible :
PARTIEL — tool-calling natif non supporté par le provider Ollama, dégrade
les modes agentiques avancés (RoleZero)

Cloud obligatoire :
NON pour usage basique, mais recommandé/nécessaire pour les fonctionnalités
agentiques avancées dépendant du function-calling

Config secrets :
~/.metagpt/config2.yaml par défaut ; chemin sûr sans écriture home confirmé
via Config.from_llm_config() — à utiliser impérativement pour Docteur

Workspace par défaut :
METAGPT_ROOT/workspace (dans l'arbre du package) — à rediriger explicitement

Exécution de code :
OUI, non sandboxée — Terminal/Bash (SYSTEM_EXECUTION), DataInterpreter/notebook
(CODE_EXECUTION), eval/exec latents sur entrée LLM

Écriture hors workspace :
RISQUE CONFIRMÉ — path traversal non sanitisé sur project_name,
shutil.rmtree() sans confirmation

Git automatisé :
OUI — git init/add/commit AUTOMATIQUE et non opt-in ; push() callable

Télémétrie :
NON TROUVÉE (recherche non exhaustive, limites d'accès API GitHub)

CVE/advisories :
4 CVE réelles vérifiées (eval RCE, SSRF, injection de commande, Tree-of-Thought
injection) — 2 confirmées présentes sur main avec PR de correctif encore
ouvertes/non mergées. SECURITY.md ne couvre formellement aucune version.

Risque supply-chain :
MOYEN

Risque exécution :
ÉLEVÉ

Risque credentials :
MOYEN

Risque filesystem :
ÉLEVÉ

Risque cloud :
FAIBLE À MOYEN

INTÉGRATION DOCTEUR RECOMMANDÉE :
OUI AVEC RESTRICTIONS SÉVÈRES

INSTALLATION RECOMMANDÉE :
OUI AVEC RESTRICTIONS SÉVÈRES
```

**Justification de "OUI AVEC RESTRICTIONS SÉVÈRES" plutôt que "NON" :** l'architecture d'isolation déjà validée pour OpenMontage (subprocess séparé, venv dédié, workspace jetable, aucun accès direct au repo Docteur) reste applicable et peut neutraliser la plupart des risques identifiés — mais seulement si l'intégration désactive explicitement dès le départ : l'outil Terminal/Bash, le module aflow, DataInterpreter/notebook (ou les isole dans un vrai conteneur sans montage hôte), et neutralise le comportement git automatique. Sans ces désactivations explicites, le risque réel serait ÉLEVÉ à INACCEPTABLE. Les 2 CVE avec PR de correctif non mergées doivent être suivies avant toute mise en production, même en environnement isolé.

**STOP.**

RIEN N'A ÉTÉ CLONÉ.
RIEN N'A ÉTÉ INSTALLÉ.
AUCUN FICHIER DOCTEUR N'A ÉTÉ MODIFIÉ.
ATTENTE DE VOTRE APPROBATION.
