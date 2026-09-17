# METAGPT — MG-1B SECURITY CONTAINMENT DESIGN

Date : 2026-09-17
Méthode : recherche technique distante en lecture seule, complémentaire à l'audit MG-1. Aucun clone, aucune installation, aucune modification de Docteur.

## Constat clé : le confinement ne peut PAS reposer sur "ne pas importer" les modules dangereux

`metagpt/tools/libs/__init__.py` importe **inconditionnellement** `terminal`, `git`, `browser`, `deployer`, `editor`, `web_scraping` dans un tuple `_` "pour éviter les erreurs de validation pre-commit". Résultat : dès qu'on fait `import metagpt` (ou n'importe quoi qui importe `metagpt.tools.libs`), Terminal/Git/Browser sont **déjà enregistrés dans le registre global `TOOL_REGISTRY`**. On ne peut donc pas se contenter d'éviter d'importer `terminal.py` — le confinement doit se faire à un autre niveau :

1. **Par rôle** : les rôles de la famille DI (`RoleZero`, `TeamLeader`, `DataInterpreter`) possèdent un champ `tools: list[str]` consommé par `validate_tool_names()`, qui restreint quels outils du registre global cette instance de rôle peut effectivement invoquer. **La classe `Role` de base n'a AUCUN mécanisme d'allowlist/denylist** — seuls les rôles DI-family en ont un.
2. **Par monkey-patch** pour les comportements sans flag de config (git automatique).
3. **Par choix de composition d'équipe** (`team.hire(roles)`) — ne jamais instancier `DataInterpreter`/`DataAnalyst`.

## 1. Fonctionnalités à désactiver — mécanisme exact par capacité

| Capacité | Mécanisme de neutralisation confirmé | Fiabilité |
|---|---|---|
| Terminal/Bash | Ne jamais inclure `"Terminal"`/`"Bash"` dans le `tools: list[str]` des rôles DI-family utilisés. **Le registre global les contient toujours** (import inconditionnel), donc c'est une neutralisation par exclusion de la liste blanche du rôle, pas une suppression du registre. | Fiable si tous les rôles utilisés sont DI-family avec `tools` explicitement contrôlé |
| DataInterpreter (notebook) | Ne jamais importer/instancier `from metagpt.roles.di.data_interpreter import DataInterpreter` (ni `DataAnalyst`). Confirmé : c'est une classe Role distincte, rien dans `Team`/`Environment` ne l'instancie automatiquement. | Fiable — simple omission suffit |
| Navigateur (Playwright) | Même mécanisme que Terminal : exclure du `tools` du rôle. Le module `web_scraping`/`browser` reste importé dans le registre global mais non atteignable si aucun rôle autorisé à l'invoquer. | Fiable si `tools` contrôlé strictement |
| `git init/add/commit` automatique | **Aucun flag de config n'existe.** `PrepareDocuments.run()` appelle inconditionnellement `_init_repo()` → `GitRepository(auto_init=True)`. Neutralisation possible par : (a) ne jamais déclencher `PrepareDocuments` (éviter le workflow SoftwareCompany classique), ou (b) pré-créer un `.git` factice au chemin cible pour que `is_git_dir()` court-circuite avant `_init()`, ou (c) monkey-patcher `GitRepository._init`/`git.Repo.init` pour no-op. | Nécessite un contournement actif — pas un simple flag |
| `eval()`/`exec()` latents | `metagpt/utils/serialize.py::eval(value)` et `metagpt/ext/aflow/scripts/operator.py::exec(code)` — ne jamais utiliser le module `aflow`, et traiter tout message inter-agents désérialisé comme non fiable. | Éviter le module aflow entièrement = suffisant pour exec() ; eval() dans serialize.py reste un risque latent si des messages externes non fiables sont désérialisés |
| Installation automatique de packages (pip/npm/pnpm) | Confirmé en MG-1 : `InstallMermaidCLI` n'est jamais déclenché par `pip install .` normal — seulement par invocation explicite. Ne jamais invoquer cette commande setuptools. | Fiable — simple omission |
| Docker | Aucune preuve d'auto-pull/auto-run trouvée en MG-1 — ne jamais exécuter `docker build`/`docker run` manuellement sur le Dockerfile du projet. | Fiable — comportement opt-in uniquement |

## 2. Périmètre autorisé — faisabilité technique

- **READ_ONLY / WORKSPACE_WRITE** : réalisable via `Config.project_path`/`workspace.path` pointé explicitement sur le job workspace Docteur (`cortex-server/data/metagpt-workspaces/<job-id>`).
- **PLAN / PROTOTYPE_TEXT_ONLY** : réalisable en composant une équipe (`team.hire([...])`) avec uniquement les rôles classiques non-DataInterpreter (ProductManager, Architect, ProjectManager, Engineer en mode écriture de fichiers uniquement — **jamais** en mode exécution).
- **APPLY_WITH_APPROVAL** : nécessite que l'adapter Docteur lise les fichiers produits dans le workspace MetaGPT et les présente comme un diff/patch à l'utilisateur, **jamais** une application directe par MetaGPT sur `C:\dev\Docteur`.

## 3. Workspace strict — confirmation technique

`Config.project_path` peut être fourni comme chemin absolu explicite, **contournant `workspace.path`** si mal utilisé (risque confirmé en MG-1) — l'adapter doit donc valider ce chemin lui-même (même logique `within()`/`checkedWorkspacePath()` que pour OpenMontage), ne jamais faire confiance à la valeur par défaut de MetaGPT. `project_name` utilisé dans la construction de chemin n'est pas sanitisé côté MetaGPT — **l'adapter Docteur doit générer et contrôler `project_name`/`project_path` lui-même**, jamais les dériver d'une entrée utilisateur non filtrée transmise telle quelle à MetaGPT.

## 4. Git — neutralisation nécessaire, pas de flag natif

Confirmé : **aucun flag de configuration ne désactive `_init_repo()`**. Deux options concrètes pour MG-2 (à trancher à ce moment-là, pas maintenant) :
- **Option A (préférée, plus sûre)** : pré-créer un dossier `.git` vide (juste le dossier, pas un vrai repo) dans le workspace avant de lancer MetaGPT, pour que `GitRepository.open()`'s `is_git_dir()` check trouve un `.git` existant et court-circuite avant `_init()`. À valider par un test dédié en MG-2 avant de s'y fier.
- **Option B** : monkey-patcher `metagpt.utils.git_repository.GitRepository._init` en no-op côté adapter Python, chargé avant tout usage de MetaGPT. Plus invasif mais plus robuste si l'option A s'avère fragile.
- Dans les deux cas, **Docteur reste le seul composant qui appelle `git`**, et seulement après approbation utilisateur, exactement comme demandé.

## 5. Terminal / Bash — confirmation de l'approche

Confirmé : la denylist native (`"run dev"`, `"serve "`) est insuffisante et ne doit pas être renforcée — la bonne approche est de ne **jamais inclure `"Terminal"`/`"Bash"` dans le `tools` allowlist** d'aucun rôle utilisé dans l'intégration Docteur. Comme le registre global contient toujours ces outils (import inconditionnel), la garantie de sécurité repose entièrement sur la discipline de configuration du `tools` de chaque rôle — l'adapter Docteur devra donc **valider par du code** (pas juste par convention) que tout rôle instancié a un `tools` explicitement défini sans Terminal/Bash/git, plutôt que de faire confiance à la valeur par défaut de la bibliothèque.

## 6. Code execution — confirmation

`DataInterpreter`/`DataAnalyst` sont des classes Role distinctes, jamais auto-instanciées par `Team`/`Environment`. **Simple omission = neutralisation fiable.** Aucune exécution de code généré (`.py`, `.ts`, tests) ne doit être déclenchée par l'adapter — les fichiers produits restent statiques dans le workspace jusqu'à récupération par Docteur.

## 7. CVE — évaluation de l'atteignabilité après confinement

| CVE | Fonction vulnérable | Atteignable dans le périmètre confiné V1 ? |
|---|---|---|
| CVE-2026-5971 (eval RCE) | `ActionNode.xml_fill` | À vérifier précisément en MG-2 si les rôles Plan/Spec/Architecture utilisés appellent `ActionNode.xml_fill` — si oui, **BLOQUANT** pour ces rôles spécifiquement jusqu'à patch ou contournement |
| CVE-2026-6111 (SSRF) | `decode_image` (`metagpt/utils/common.py`) | Non atteignable si aucun rôle du périmètre V1 ne traite d'images distantes (le périmètre "spec/architecture/plan/prototype texte" ne devrait pas déclencher `decode_image`) — **à confirmer explicitement en MG-2** avant d'exclure ce risque |
| CVE-2026-11455 (injection commande mermaid.path) | `check_cmd_exists` | Non atteignable si Mermaid n'est jamais configuré/invoqué dans le périmètre V1 |
| CVE-2026-6110 (Tree-of-Thought) | `metagpt/strategy/tot.py` | Non atteignable si le module Tree-of-Thought n'est jamais utilisé — à exclure explicitement de la composition d'équipe |

**Recommandation** : plutôt que de patcher ces CVE localement (mission de créer un fork lourd non souhaitée), les neutraliser par **non-usage** des composants concernés (`ActionNode.xml_fill` si évitable, `decode_image`, Mermaid, Tree-of-Thought) — à vérifier précisément quels rôles/actions du périmètre V1 (ProductManager/Architect/ProjectManager en mode plan/spec) appellent effectivement `ActionNode.xml_fill`, car c'est une primitive assez centrale dans le framework et pourrait être difficile à éviter totalement. **Ce point doit être vérifié empiriquement en MG-2 avant de considérer les CVE comme neutralisées** — l'audit actuel ne peut pas garantir à 100% qu'aucun rôle du périmètre V1 n'appelle `xml_fill`.

## 8. Provider — Ollama local confirmé viable pour le périmètre V1

Confirmé techniquement : `RoleZero._think()`/`_act()` utilise une architecture "prompt-and-parse-texte" (`llm_cached_aask()` puis `parse_commands()` sur la réponse texte brute), **pas** de function-calling natif OpenAI. Les rôles classiques (ProductManager, Architect, ProjectManager, Engineer) utilisent des patterns encore plus simples de prompt structuré. **Le périmètre V1 (spec/architecture/plan/prototype texte) devrait fonctionner correctement avec Ollama seul**, sans dégradation majeure attendue — contrairement aux workflows RoleZero/TeamLeader les plus avancés qui pourraient avoir des besoins de tool-calling plus poussés (mais ceux-ci ne font pas partie du périmètre V1 de toute façon).

`Config.from_llm_config()` reste utilisable, mais **attention** : `Config.default()` fusionne quand même `dict(os.environ)` comme couche de base même dans ce chemin — l'isolation complète de l'environnement nécessite de contrôler l'environnement réel du processus Python (via l'adapter Node qui spawn ce process avec un environnement filtré), pas seulement de choisir `from_llm_config()` côté MetaGPT.

## 9. process.env — fuites confirmées à plusieurs niveaux indépendants

Confirmé : `Path.home()`/`os.environ` sont lus à **trois endroits indépendants** :
1. `const.py` au chargement du module (`os.getenv("METAGPT_PROJECT_ROOT")`, `os.environ.get("METAGPT_REPORTER_URL", "")`)
2. `Config.default()` (`dict(os.environ)` comme couche de fusion)
3. `Context.config` avec `default_factory=Config.default` — tout `Context`/`Team` construit sans `Config` explicite redéclenche la lecture

**Conclusion pratique** : la seule garantie fiable est de contrôler l'environnement du **processus OS lui-même** (comme déjà fait pour OpenMontage via `filteredEnv()` dans l'adapter Node — spawn avec un environnement whitelisté, jamais `process.env` complet), plutôt que de compter sur le comportement interne de MetaGPT pour ignorer les variables sensibles. C'est exactement le pattern déjà validé et testé pour OpenMontage — directement réutilisable ici.

## 10. Réseau — confirmation

`SearchEngine` nécessite une instanciation explicite + une clé API (SerperGoogle par défaut) — non auto-déclenché par une config Ollama seule. Mais **la garantie réelle contre les appels réseau non désirés vient de la restriction du `tools` par rôle (point 1/5), pas de la config LLM** : si un rôle autorisé conserve `Browser`/`Searcher` dans son `tools`, un texte généré par le LLM (même local) peut déclencher `parse_commands()` vers ces outils indépendamment du provider LLM utilisé. **Non vérifié avec certitude** : la valeur par défaut exacte de `RoleZero.tools` (seul `TeamLeader.tools` a été confirmé) — à vérifier précisément en MG-2 avant de faire confiance à une configuration par défaut.

---

# METAGPT SECURITY CONTAINMENT

```
Terminal/Bash désactivable :
OUI (par exclusion du champ tools:list[str] du rôle — pas par suppression du
registre global, qui reste toujours peuplé)

DataInterpreter désactivable :
OUI (simple omission — classe Role distincte, jamais auto-instanciée)

Git automatique neutralisable :
OUI AVEC CONTOURNEMENT ACTIF (aucun flag natif — nécessite soit un .git
factice pré-créé, soit un monkey-patch de GitRepository._init/Repo.init ;
à valider empiriquement en MG-2)

Filesystem confinable :
OUI AVEC VALIDATION ADAPTER (Config.project_path peut être un chemin absolu
arbitraire fourni par MetaGPT lui-même — l'adapter Docteur doit imposer sa
propre validation within()/checkedWorkspacePath(), ne jamais faire confiance
au comportement par défaut de MetaGPT)

HOME/config évitable :
PARTIELLEMENT — Config.from_llm_config() évite l'écriture, mais la LECTURE
de os.environ/Path.home() se produit à 3 endroits indépendants (const.py,
Config.default(), Context factory) ; garantie réelle seulement via le
contrôle de l'environnement du processus OS par l'adapter Node (comme pour
OpenMontage), pas via l'API Python de MetaGPT seule

process.env filtrable :
OUI (au niveau du processus OS via l'adapter — pattern déjà validé et testé
pour OpenMontage, directement réutilisable)

Internet bloquable :
OUI EN PRINCIPE (SearchEngine non auto-instancié sans clé), MAIS la garantie
réelle dépend de la restriction du tools par rôle, pas de la config LLM
seule — valeur par défaut exacte de RoleZero.tools non vérifiée avec
certitude, à confirmer en MG-2

Ollama local utilisable :
OUI pour le périmètre V1 (spec/architecture/plan/prototype texte) — RoleZero
et les rôles classiques utilisent une architecture prompt-and-parse-texte,
pas de function-calling natif requis

CVE atteignables après confinement :
NON CONFIRMÉ À 0 — 3 des 4 CVE (SSRF, injection mermaid, Tree-of-Thought)
sont neutralisables par non-usage des composants concernés ; la 4e
(eval RCE dans ActionNode.xml_fill) nécessite une vérification empirique en
MG-2 pour confirmer qu'aucun rôle du périmètre V1 ne l'appelle — xml_fill
est une primitive potentiellement centrale, ne pas supposer qu'elle est
évitable sans vérification

Exécution de code :
DÉSACTIVÉE (par omission de DataInterpreter/DataAnalyst et par exclusion de
Terminal/Bash des tools de chaque rôle)

Écriture hors workspace :
NÉCESSITE VALIDATION ADAPTER ACTIVE (pas nativement impossible côté
MetaGPT — l'adapter doit imposer ses propres garde-fous de chemin, comme
pour OpenMontage)

Git :
DÉSACTIVABLE AVEC CONTOURNEMENT ACTIF (voir ci-dessus, pas un simple flag)

Cloud :
0 (aucune clé cloud transmise, Ollama uniquement, SearchEngine non
auto-instancié)

Architecture proposée :
C:\dev\Docteur\external\MetaGPT (SHA épinglé)
C:\dev\Docteur\external\MetaGPT\.venv (Python 3.9, isolé)
C:\dev\Docteur\cortex-server\data\metagpt-workspaces\<job-id>\{input,output,artifacts}
MetaGPTAdapter (Node) : environnement OS filtré (pattern OpenMontage réutilisé),
validation stricte des chemins (within()/checkedWorkspacePath()),
composition d'équipe limitée aux rôles classiques (ProductManager, Architect,
ProjectManager) SANS DataInterpreter/DataAnalyst, tools de chaque rôle
explicitement vidé de Terminal/Bash/Browser/git, .git factice ou monkey-patch
pour neutraliser GitRepository._init, config LLM en mémoire pointée sur
Ollama local uniquement (jamais ~/.metagpt/config2.yaml)

INSTALLATION MG-2 AUTORISABLE :
OUI AVEC RESTRICTIONS — sous réserve que MG-2 commence par une VÉRIFICATION
EMPIRIQUE (dans le venv isolé, avant tout usage réel) des deux points non
confirmés à 100% par cet audit distant :
  1. Le mécanisme de neutralisation de git init (option .git factice vs
     monkey-patch) fonctionne réellement tel que prévu
  2. Aucun rôle du périmètre V1 (ProductManager/Architect/ProjectManager en
     mode plan/spec) n'appelle ActionNode.xml_fill de façon inévitable
Si l'un de ces deux points échoue à la vérification empirique,
l'installation doit être reconsidérée avant de continuer.
```

**STOP.**

RIEN N'A ÉTÉ CLONÉ.
RIEN N'A ÉTÉ INSTALLÉ.
AUCUN FICHIER DOCTEUR N'A ÉTÉ MODIFIÉ.
ATTENTE DE VOTRE APPROBATION AVANT MG-2.
