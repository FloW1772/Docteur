# METAGPT — Patches Docteur (installation isolée V1)

Dépôt : `C:\dev\Docteur\external\MetaGPT`
SHA upstream épinglé : `11cdf466d042aece04fc6cfd13b28e1a70341b1f` (HEAD detached, jamais `main` flottant)

## Contexte

Ces 4 patches minimaux ont été nécessaires pour permettre l'import de `ProductManager`, `Architect`, `ProjectManager` et `RoleZero` avec Ollama local uniquement, sans installer les SDK cloud (anthropic, boto3, dashscope, google-generativeai, qianfan, zhipuai, spark-ai-python, volcenginesdkarkruntime) ni les dépendances lourdes hors-scope (sklearn, joblib, chromadb, llama_index, pyppeteer).

**Cause structurelle commune** : plusieurs fichiers `__init__.py` de MetaGPT importent inconditionnellement TOUS les sous-modules d'une catégorie (tous les providers LLM, tous les outils, toutes les Actions, tous les Rôles), au lieu d'un chargement paresseux. Un consommateur qui n'a besoin que d'un sous-ensemble (Ollama + 3 rôles de planification) hérite quand même de toute la surface d'import du fichier `__init__.py` du package, à cause du comportement standard de Python (importer un sous-module exécute d'abord le `__init__.py` du package parent).

**Principe appliqué aux 4 patches** : ne retirer que ce qui est confirmé, par lecture directe du code, comme n'étant *jamais* référencé (directement ou transitivement) par `ProductManager`, `Architect`, `ProjectManager` ou `RoleZero`. Chaque retrait a été vérifié empiriquement (import réel en process Python frais et isolé, HOME sandboxé), pas seulement par analyse statique.

**Procédure de réapplication sur un futur SHA** : si le clone est un jour resynchronisé sur un SHA plus récent, chacun des 4 fichiers ci-dessous doit être ré-audité (les imports amont ont pu changer) puis le même principe de réduction ré-appliqué manuellement — ce ne sont pas des patches méchaniques (`git apply`) censés s'appliquer tels quels sur un fichier différent, car le contenu upstream peut avoir évolué. Le git blob hash de chaque version originale (ci-dessous) permet de retrouver l'exact contenu de référence via `git cat-file -p <hash>` pour faire le diff manuel.

---

## Patch 1 — `metagpt/provider/__init__.py`

**Hash original (SHA256)** : `b7e646e99772849f8a6302fefbc02d21d080ad1758d424544e26765dd8c14669`
**Git blob hash original** : `4ace734458d24038d516216bc978b11889e59c1a`
**Hash après patch (SHA256)** : `2f89de8a319b5b62a2e023efa78c5f24cf1f8f780d90b94244cdf1e83e6b1296`

**Diff appliqué** :
```diff
-from metagpt.provider.google_gemini_api import GeminiLLM
+# DOCTEUR PATCH — Ollama-local-only, no cloud SDK installed.
 from metagpt.provider.ollama_api import OllamaLLM
-from metagpt.provider.openai_api import OpenAILLM
-from metagpt.provider.zhipuai_api import ZhiPuAILLM
-from metagpt.provider.azure_openai_api import AzureOpenAILLM
-from metagpt.provider.metagpt_api import MetaGPTLLM
 from metagpt.provider.human_provider import HumanProvider
-from metagpt.provider.spark_api import SparkLLM
-from metagpt.provider.qianfan_api import QianFanLLM
-from metagpt.provider.dashscope_api import DashScopeLLM
-from metagpt.provider.anthropic_api import AnthropicLLM
-from metagpt.provider.bedrock_api import BedrockLLM
-from metagpt.provider.ark_api import ArkLLM
-from metagpt.provider.openrouter_reasoning import OpenrouterReasoningLLM

 __all__ = [
-    "GeminiLLM", "OpenAILLM", "ZhiPuAILLM", "AzureOpenAILLM", "MetaGPTLLM",
     "OllamaLLM", "HumanProvider",
-    "SparkLLM", "QianFanLLM", "DashScopeLLM", "AnthropicLLM", "BedrockLLM",
-    "ArkLLM", "OpenrouterReasoningLLM",
 ]
```

**Justification** :
- `OllamaLLM` : nécessaire — s'enregistre dans `LLM_REGISTRY` via `@register_provider(LLMType.OLLAMA)`, sélectionné par `config.llm.api_type`.
- `HumanProvider` : nécessaire — `metagpt/roles/role.py` (classe `Role` de base) l'importe directement et l'instancie (`self.llm = HumanProvider(None)`), indépendamment du provider cloud configuré.
- `MetaGPTLLM` : retiré — vérifié non nécessaire, utilisé uniquement par `metagpt/memory/brain_memory.py`, jamais importé par les 4 rôles cibles.
- Les 11 autres providers cloud : retirés — chacun a un import de son SDK propre au niveau module (`anthropic`, `boto3`, `dashscope`, `google.generativeai`, `qianfan`, `sparkai`, `zhipuai`, `volcenginesdkarkruntime`) ; aucun n'est référencé par les 4 rôles cibles.

**Dépendances évitées** : anthropic, boto3, dashscope, google-generativeai, qianfan, zhipuai, spark-ai-python, volcenginesdkarkruntime, openai-sdk-specifique-au-provider (le paquet `openai` reste installé car utilisé génériquement par `base_llm.py`, mais aucun client OpenAI n'est jamais instancié).

---

## Patch 2 — `metagpt/tools/libs/__init__.py`

**Hash original (SHA256)** : `e12738e1554c3e6ed22797b86196083c132428086bd36e6ad3a81595f93350d5`
**Git blob hash original** : `6f8f754e7732aba48a361162832dd00d3eb6a3f5`
**Hash après patch (SHA256)** : `417bdb063cd919ae1f88dde5bf6dbf4b13a832da9a8c944bac96ce71cf232a0c`

**Diff appliqué** :
```diff
 from metagpt.tools.libs import (
-    data_preprocess,
-    feature_engineering,
-    sd_engine,
-    gpt_v_generator,
-    web_scraping,
-    # email_login,
     terminal,
     editor,
     browser,
-    deployer,
-    git,
 )
```
(et symétriquement dans le tuple `_ = (...)` qui suit)

**Justification** :
- `editor` : nécessaire — importé directement par `ProductManager` et `RoleZero`, référencé dans le `tools` des 3 rôles.
- `terminal` : nécessaire à l'IMPORT uniquement — `Architect` l'importe directement et l'instancie via `Field(default_factory=Terminal, exclude=True)`. **Jamais placé dans le `tools` réel construit par l'adapter Docteur** (voir section sécurité ci-dessous).
- `browser` : nécessaire à l'IMPORT uniquement — même situation, importé directement par `ProductManager`/`RoleZero`. **Jamais activé par l'adapter**.
- `data_preprocess`, `feature_engineering` : retirés — cause du blocage `sklearn`/`joblib`, usage limité à `ext/sela/` (hors scope), jamais référencés par les 4 rôles cibles.
- `sd_engine`, `gpt_v_generator` : retirés — génération d'images, jamais référencés.
- `web_scraping` : retiré — jamais référencé directement par les 4 rôles cibles (le scraping web passe par `research.py`/`web_browser_engine.py`, un chemin différent).
- `deployer` : retiré — jamais référencé.
- `git` (le tool, distinct de `git_repository.py`) : retiré — jamais référencé par les 4 rôles cibles ; `git_repository.py` importe `pygithub` séparément et indépendamment de ce fichier.

**Dépendances évitées** : sklearn, joblib.

---

## Patch 3 — `metagpt/actions/__init__.py`

**Hash original (SHA256)** : `31dd9bad68e6a32545bd24aa02f8d271b4a907604898c8eb98c198e24550f7e4`
**Git blob hash original** : `495ed403133200363b6b13b7736c7399441acf90`
**Hash après patch (SHA256)** : `cbd3ce5885b7f3ce74169aa116f3a30ed983d8809d261870a89c7b04071c2804`

**Diff appliqué** :
```diff
 from metagpt.actions.add_requirement import UserRequirement
-from metagpt.actions.debug_error import DebugError
 from metagpt.actions.design_api import WriteDesign
-from metagpt.actions.design_api_review import DesignReview
 from metagpt.actions.project_management import WriteTasks
-from metagpt.actions.research import CollectLinks, WebBrowseAndSummarize, ConductResearch
-from metagpt.actions.run_code import RunCode
-from metagpt.actions.search_and_summarize import SearchAndSummarize
-from metagpt.actions.write_code import WriteCode
-from metagpt.actions.write_code_review import WriteCodeReview
+from metagpt.actions.research import CollectLinks, WebBrowseAndSummarize
 from metagpt.actions.write_prd import WritePRD
-from metagpt.actions.write_prd_review import WritePRDReview
-from metagpt.actions.write_test import WriteTest
-from metagpt.actions.di.execute_nb_code import ExecuteNbCode
-from metagpt.actions.di.write_analysis_code import WriteAnalysisCode
-from metagpt.actions.di.write_plan import WritePlan
```
(et symétriquement dans l'enum `ActionType`, retrait de 12 des 18 entrées d'origine — voir git diff complet dans le repo pour le détail exact)

**Justification** :
- `Action`, `ActionOutput`, `UserRequirement`, `WritePRD`, `WriteDesign`, `WriteTasks` : nécessaires — importés directement par les 4 rôles cibles.
- `CollectLinks`, `WebBrowseAndSummarize` : nécessaires — `metagpt/actions/search_enhanced_qa.py` (importé au niveau module par `ProductManager` et `RoleZero`, pour référencer `SearchEnhancedQA.__name__` dans leur `tools`) importe ces deux classes depuis `research.py`. Ceci force transitivement `htmlmin` (via `metagpt/utils/parse_html.py`) — voir exception sdist ci-dessous.
- `ConductResearch` : retiré — même fichier `research.py`, mais cette classe précise n'est référencée nulle part, retrait sans effet sur les dépendances.
- `DebugError`, `DesignReview`, `RunCode`, `SearchAndSummarize`, `WriteCode`, `WriteCodeReview`, `WritePRDReview`, `WriteTest` : retirés — Actions du workflow SoftwareCompany classique (Engineer/QA), jamais référencées par les 4 rôles cibles.
- `ExecuteNbCode`, `WriteAnalysisCode`, `WritePlan` : retirés — Actions DataInterpreter (exécution de notebook), explicitement hors périmètre V1.

**Dépendance NON évitée, exception sdist documentée** : `htmlmin==0.1.12` — installé (sdist, pure Python, aucune extension native, inspecté avant installation) car réellement et structurellement nécessaire (contrairement à une première analyse qui la croyait évitable). `ConductResearch`, `ExecuteNbCode`, `WriteAnalysisCode`, `WritePlan`, et les 8 Actions SoftwareCompany : retirés sans exception, confirmés non nécessaires.

---

## Patch 4 — `metagpt/roles/__init__.py`

**Hash original (SHA256)** : `cbaf47bc5e9255a8f78bd8f45cd8ccab8bef83bfffe5c570d48d976d623adbde`
**Git blob hash original** : `c853604db25ef1be59032173356f33c5a36a49e5`
**Hash après patch (SHA256)** : `1ed8ee0bee5a7124692fe64199dd351e1d895b6612665b76b80248427055ec9e`

**Diff appliqué** :
```diff
 from metagpt.roles.role import Role
+from metagpt.roles.di.role_zero import RoleZero
 from metagpt.roles.architect import Architect
 from metagpt.roles.project_manager import ProjectManager
 from metagpt.roles.product_manager import ProductManager
-from metagpt.roles.engineer import Engineer
-from metagpt.roles.qa_engineer import QaEngineer
-from metagpt.roles.searcher import Searcher
-from metagpt.roles.sales import Sales
-from metagpt.roles.di.data_analyst import DataAnalyst
-from metagpt.roles.di.team_leader import TeamLeader
-from metagpt.roles.di.engineer2 import Engineer2

 __all__ = [
-    "Role", "Architect", "ProjectManager", "ProductManager",
-    "Engineer", "QaEngineer", "Searcher", "Sales", "DataAnalyst",
-    "TeamLeader", "Engineer2",
+    "Role", "RoleZero", "Architect", "ProjectManager", "ProductManager",
 ]
```

**Cause découverte** : `RoleZero` (classe de base de `ProductManager`/`Architect`/`ProjectManager`) fait `from metagpt.roles import Role` — ceci force l'exécution complète de `roles/__init__.py`, qui importait inconditionnellement les 7 rôles hors-scope. Confirmé par test empirique en process Python frais et isolé (répété 3× par rôle avant patch, tous FAIL identiques ; répété 3× par rôle après patch, tous PASS identiques) — un premier test dans un process partagé avait donné un résultat trompeur (faux PASS pour 3 rôles) à cause de la mise en cache `sys.modules` de Python après un échec partiel du premier rôle testé dans le même process.

**Justification** :
- `Role`, `RoleZero`, `ProductManager`, `Architect`, `ProjectManager` : les 5 seuls rôles réellement nécessaires au périmètre V1.
- `Engineer`, `QaEngineer` : retirés — rôles SoftwareCompany classiques (écriture/test de code), sources des imports `WriteCode`/`WriteCodeReview`/`DebugError`/`RunCode`/`WriteTest` déjà retirés du Patch 3.
- `Searcher`, `Sales` : retirés — nécessitent `SearchAndSummarize`, également retiré.
- `DataAnalyst` : retiré — DataInterpreter/exécution de notebook, explicitement hors scope.
- `TeamLeader`, `Engineer2` : retirés — non référencés par le périmètre V1.

**Dépendances évitées** : aucune nouvelle (ce patch referme la chaîne d'import plutôt que d'éviter un paquet supplémentaire), mais empêche la ré-exigence des 8 Actions SoftwareCompany déjà retirées au Patch 3.

---

## Résumé des 4 patches — vérification empirique finale

Testé en process Python frais et isolé (HOME sandboxé `C:\dev\Docteur\cortex-server\data\metagpt-home-test`, config Ollama locale avec sentinelle `DOCTEUR_METAGPT_LOCAL_SENTINEL`, réseau externe bloqué activement), répété 3× par rôle :

```
Role : PASS, PASS, PASS
RoleZero : PASS, PASS, PASS
ProductManager : PASS, PASS, PASS
Architect : PASS, PASS, PASS
ProjectManager : PASS, PASS, PASS
```

**Modules confirmés absents de `sys.modules`** après import complet des 5 classes : `sklearn`, `joblib`, `chromadb`, `llama_index`, `pyppeteer`, `metagpt.actions.di.execute_nb_code`, `metagpt.roles.engineer`, `metagpt.roles.qa_engineer`, `metagpt.roles.di.data_analyst`.

**Point de sécurité critique — non résolu par ces patches, à traiter par l'adapter Docteur** : `Terminal`, `Browser`, `Bash` restent dans le `ToolRegistry` global (10 outils enregistrés : `Bash, Browser, Editor, Plan, RoleZero, SearchEnhancedQA, Terminal, WriteDesign, WritePRD, WriteTasks`), et `Architect.tools`/`ProductManager.tools` déclarent nativement `Terminal:run_command`/`Browser` par défaut. **Ces patches d'import ne retirent PAS ces outils du registre ni des rôles** — ils garantissent seulement que les *modules Python* correspondants n'entraînent pas de dépendances lourdes inutiles à l'import. La neutralisation fonctionnelle de Terminal/Browser/Bash doit venir de l'adapter Docteur, qui doit construire explicitement le `tools` de chaque instance de rôle en excluant ces noms avant tout `role.run()` — ceci reste à concevoir et tester (hors périmètre de cette phase MG-2, prévu pour l'étape d'adapter).

**Aucun workflow MetaGPT réel n'a été exécuté** durant la conception/vérification de ces 4 patches — uniquement des imports de classes et une lecture de configuration en mémoire.

---

## MG-2G — Neutralisation Git + Tool Policy (côté Docteur, 0 patch upstream supplémentaire)

Cette phase répond au point de sécurité critique laissé ouvert ci-dessus. **Aucun 5e fichier MetaGPT n'a été modifié** — toute la neutralisation vit dans deux nouveaux fichiers côté Docteur :
- `cortex-server/src/lib/metagpt-policy.js` (Node — construction de la policy, JSON vers le bootstrap Python)
- `cortex-server/src/lib/metagpt_policy.py` (Python — revalidation indépendante, jamais de confiance aveugle dans ce que Node envoie)

### Audit Git (lecture seule, aucune exécution)

- `GitRepository.is_git_dir(...)` (méthode statique, lecture seule) est atteinte par `ProductManager._think()` — sûre.
- `GitRepository(...)` (constructeur réel, déclenche `_init()` → `git init` + commit `.gitignore`) n'est atteint que via `ProjectRepo(path)` → `PrepareDocuments._init_repo()` → `PrepareDocuments.run()`. **Aucun des 4 rôles cibles n'instancie `GitRepository` à l'import ou à la construction** — seule l'exécution réelle de l'Action `PrepareDocuments` l'atteint.
- `push()` exige un `access_token` réel (`ValueError` sinon), construit `["git", ...]` en liste (`shell=False`), authentifie un remote — barrière naturelle forte tant qu'aucun token n'est fourni.
- `delete_repository()` fait un `shutil.rmtree()` — nécessite une instance `GitRepository` valide déjà construite.

**Conclusion** : tant que l'adapter Docteur n'exécute jamais `role.run()`/`action.run()` (hors périmètre V1 actuel), `GitRepository` n'est jamais atteint. Vérifié empiriquement avec des guards `Repo.init`/`subprocess`/`shutil.rmtree` levant une exception immédiate si jamais atteints : sur l'import des 4 rôles + instanciation, **0 déclenchement**. Un test délibéré d'instanciation directe de `GitRepository(auto_init=True)` a bien déclenché le guard `Repo.init` (1 fois, comme attendu), confirmant que le mécanisme de détection fonctionne et qu'aucun `.git` réel n'a été créé.

### Découverte critique qui a façonné le design de la policy

**`tool_execution_map` se peuple indépendamment de la valeur `tools` passée au constructeur.** Vérifié empiriquement : `ProductManager(tools=["Editor:write,read,similarity_search"])` produit quand même un `tool_execution_map` de 31 clés, incluant tous les `Browser.*`, `Terminal.run_command` (pour Architect), `Plan.*`, `WritePRD`/`WritePRD.run` — identique à l'instance non filtrée. **Le paramètre constructeur `tools` n'est donc jamais une barrière de sécurité réelle** dans cette version de MetaGPT — seul un filtrage post-construction de `tool_execution_map` (le dictionnaire réellement consulté à l'exécution) compte.

**Second point critique découvert en test réel end-to-end** : un premier appel `Editor.write` a réussi la validation d'arguments (chemin validé comme étant dans le workspace du job) mais **le fichier a été réellement écrit dans `external/MetaGPT/workspace/`**, pas dans le workspace attendu. Cause : `Editor` résout tout chemin relatif via son propre attribut d'instance `working_dir` (`_try_fix_path()`), indépendant du chemin que la policy valide. Corrigé par `bind_editor_to_workspace()`, qui force `editor.working_dir` sur le workspace du job — appelé obligatoirement dans `execute_authorized_tool()` avant toute validation d'arguments, pour que la résolution de policy et la résolution réelle de l'outil ne divergent jamais.

### Allowlist finale (clés d'exécution exactes, auditées empiriquement)

```
ProductManager : Editor.write, Editor.read, Editor.similarity_search
Architect      : Editor.write, Editor.read, Editor.similarity_search
ProjectManager : Editor.write, Editor.read, Editor.similarity_search, WriteTasks, WriteTasks.run
RoleZero       : Editor.write, Editor.read, Editor.similarity_search
```

`WriteTasks`/`WriteTasks.run` vérifiés référencer le même callable (`__self__`/`__func__` identiques) — autoriser les deux clés pour `ProjectManager` est sûr, ce ne sont pas deux comportements distincts.

### Ordre d'exécution obligatoire (`execute_authorized_tool`)

```
1. scrub_tool_execution_map   — nettoie toute mutation survenue depuis la dernière vérification
2. bind_editor_to_workspace   — aligne Editor.working_dir sur le workspace réel
3. authorize_tool_call        — deny-by-default sur la clé d'exécution exacte, retourne la clé canonique
4. authorize_tool_arguments   — deny-by-default sur les arguments (chemin), en utilisant UNIQUEMENT la clé canonique
5. lookup tool_execution_map[canonical] — seulement après les 4 étapes précédentes
6. invocation du callable
```

L'adapter Docteur n'expose aucun autre chemin permettant d'appeler `role.tool_execution_map[key](...)` directement.

### Résultats des tests

```
Method allowlist : PASS (25/25 Node, inclus dans les 32 Python)
Argument/path allowlist : PASS
tool_execution_map scrub : PASS (post-condition `remaining ⊆ allowed` vérifiée sur vraies instances : 
  ProductManager 31→3 clés, Architect 30→3, ProjectManager 31→5, RoleZero 29→3)
Mutation post-construction : BLOQUÉE (injection Editor.delete/Terminal.run_command après construction,
  neutralisée par re-scrub ; mutation de la copie Node n'affecte jamais la table centrale — testé)
Editor path escape : BLOQUÉ (traversal, absolu, UNC, symlink, substrings interdits — tous testés)
Terminal : BLOQUÉ (jamais dans aucune allowlist de rôle)
Browser : BLOQUÉ (idem, confirmé aussi en exécution réelle contre une vraie instance ProductManager)
Bash : BLOQUÉ
Git : BLOQUÉ (jamais atteint — voir audit Git ci-dessus)
Plan : BLOQUÉ
Unknown tool / unknown method : BLOQUÉ (deny-by-default absolu, jamais "safe par défaut")
Chemin de fichier comme identité de tool (vecteur register_tools_from_path) : BLOQUÉ
Subprocess système atteint : 0
Cloud : 0
Credentials : 0
Fichiers MetaGPT upstream supplémentaires modifiés : 0 (toujours 4 au total : provider, tools/libs, actions, roles)

Tests : 25/25 (Node, test-metagpt-policy.mjs) + 32/32 (Python, tests-python/test_metagpt_policy.py) = 57/57
```

**MG-2G : PASS**

Test end-to-end réel supplémentaire (hors suite automatisée, exécuté manuellement dans le venv isolé) : `execute_authorized_tool` contre une vraie instance `ProductManager` — `Browser.goto` refusé avant tout code Browser réel, path escape via `Editor.write` refusé avant tout accès disque réel, écriture légitime dans le workspace du job réussie et vérifiée au bon emplacement exact (fichier de test nettoyé après vérification).

---

## MG-2H — ActionNode.xml_fill / CVE-2026-5971 RCE Reachability

**Fichier** : `metagpt/actions/action_node.py` — **Fonction** : `ActionNode.xml_fill` (lignes 553-594) — **Primitive dangereuse** : `eval(raw_value)` (lignes 581 et 588), appliqué quand un champ est de type `list` ou `dict`, sur une valeur extraite par regex de `content = await self.llm.aask(context, images=images)` (ligne 561) — donc directement de la sortie du LLM, sans validation ni sanitisation.

**Callers directs** : `ActionNode.fill()`, uniquement si `mode == FillMode.XML_FILL.value` (`"xml_fill"`, comparaison stricte, ligne 640). Callers qui demandent réellement ce mode dans tout le dépôt : `metagpt/ext/aflow/scripts/operator.py` et `optimizer.py` (module `aflow`, confirmé hors closure d'import des 4 rôles V1).

### Cause exacte de l'inaccessibilité (formulation corrigée)

**La raison principale et directe** : aucun caller du périmètre V1 (`WritePRD.fill()`, `WriteDesign.fill()`, `WriteTasks.fill()`) ne passe jamais `mode="xml_fill"` — ni même `mode=` du tout. `ActionNode.fill()` retombe donc systématiquement sur son défaut de signature `mode="auto"`, qui route vers `simple_fill()`/logique par nœuds JSON, jamais vers `xml_fill()`.

`prompt_schema: Literal["json","markdown","raw"]` (config2.py:76) est un paramètre **distinct** de `mode` — il contrôle le paramètre `schema` de `fill()` (format d'exemple/sortie : json/markdown/raw), pas le paramètre `mode` (auto/children/root/xml_fill/code_fill/single_fill). Cette contrainte Pydantic stricte est une **défense structurelle supplémentaire** (elle empêcherait `schema` de valoir `"xml_fill"` si jamais quelque chose essayait de le faire transiter par ce paramètre), mais **elle n'est pas la cause du choix de `FillMode`** — les deux mécanismes sont indépendants et il ne faut pas les confondre dans l'analyse de reachability.

### Reachability par rôle

```
ProductManager : UNREACHABLE — WritePRD.fill(req=context, llm=self.llm, exclude=exclude,
  schema=self.prompt_schema) ne passe jamais mode= → reste sur mode="auto" par défaut
Architect : UNREACHABLE — WriteDesign.fill(req=context, llm=self.llm, schema=self.prompt_schema),
  même mécanisme
ProjectManager : UNREACHABLE — WriteTasks.fill(req=context, llm=self.llm, schema=self.prompt_schema),
  même mécanisme
RoleZero : UNREACHABLE — n'appelle jamais .fill()/xml_fill directement (confirmé par recherche
  exhaustive du closure de 167 fichiers)
```

### Test empirique par interception sentinelle (aucune exécution réelle)

- **Test 1** — `xml_fill()` appelé directement avec un LLM factice retournant `"__import__('os').system('SENTINEL_SHOULD_NEVER_RUN')"` comme valeur d'un champ `list` : `eval()` intercepté et atteint **1 fois** — confirme que la vulnérabilité CVE-2026-5971 est réelle et fonctionnelle dans le code actuel si `xml_fill` est invoqué.
- **Test 2** — `WRITE_PRD_NODE.fill(req=..., llm=..., exclude=[], schema="json")`, reproduisant exactement la forme d'appel de `write_prd.py` : `eval()` **jamais atteint** (0/0) après 6 tentatives de retry (l'appel échoue normalement par une `ValidationError` Pydantic JSON, confirmant que c'est bien le chemin JSON/`simple_fill` qui est emprunté, jamais `xml_fill`).

### Autres primitives dangereuses scannées dans le closure V1 (167 fichiers)

| Primitive | Fichier | Verdict |
|---|---|---|
| `eval(value)` | `metagpt/utils/serialize.py:56` (`actionoutput_str_to_mapping`) | UNREACHABLE — appelée uniquement par `Message.check_instruct_content` quand `instruct_content` est un `dict` avec clés `"class"`+`"mapping"` ; confirmé qu'aucun point du closure V1 ne construit jamais `instruct_content` sous cette forme (toujours un objet `BaseModel` déjà construit via `AIMessage.create_instruct_value`/`output_class(**parsed_data)`) |
| `pickle.loads(...)` | `metagpt/utils/serialize.py:75` (`deserialize_message`) | UNREACHABLE — fonction jamais appelée dans le closure V1 (confirmé par recherche exhaustive) |
| `compile(code, fname, "exec")` | `metagpt/tools/libs/linter.py:125` | UNREACHABLE pour V1 — `compile()` seul sans `exec()` sur le résultat (lint syntaxique) ; appelé uniquement via `Editor._lint_file()`, lui-même gardé par `enable_auto_lint=False` par défaut et jamais invoqué depuis `Editor.write` (seule méthode d'écriture autorisée par la policy MG-2G) |
| `ast.literal_eval(...)` (×3) | `metagpt/utils/common.py` | SAFE par design — n'exécute jamais de code, n'accepte que des littéraux Python syntaxiquement valides |

Aucun `yaml.load` non sécurisé, `marshal`, ni `dill` trouvé dans le closure V1.

### Nécessité de xml_fill pour V1

`OUI/NON` par rôle : **NON** pour les 4 rôles (`ProductManager`, `Architect`, `ProjectManager`, `RoleZero`) — `xml_fill` est un chemin utilisé uniquement par le module `aflow` (framework d'optimisation de workflow), complètement hors périmètre V1 et jamais importé. Mort code sans impact fonctionnel pour notre usage.

### MG-2G protège-t-elle contre cette RCE ?

**NON PERTINENT dans la pratique actuelle** — la RCE n'est jamais atteinte dans le chemin V1 réel, donc la question de mitigation ne se pose pas. **Mais si `xml_fill` était atteint par une régression future, MG-2G n'offrirait aucune protection** : la tool policy contrôle quelles clés d'exécution de `tool_execution_map` sont invocables — un mécanisme entièrement différent et sans rapport avec le parsing interne de la réponse LLM par `ActionNode.fill()`. Un `eval()` réussi s'exécuterait avec les pleins privilèges du process Python, hors du contrôle de la tool policy.

### Test de régression permanent

`cortex-server/tests-python/test_metagpt_xmlfill_regression.py` (4 tests, purement statique — lecture de source, aucun import du package `metagpt` requis sauf mention contraire) :
- `test_no_v1_action_passes_mode_xml_fill` — échoue si `WritePRD`/`WriteDesign`/`WriteTasks` commencent à passer `mode="xml_fill"` **ou tout `mode=` explicite** (un `mode=` de n'importe quelle valeur invalide l'hypothèse de sécurité actuelle et exige un nouvel audit).
- `test_action_node_fill_default_mode_is_still_auto` — échoue si le défaut de signature de `ActionNode.fill()` change de `"auto"` vers autre chose.
- `test_no_new_v1_reachable_caller_of_xml_fill_mode_value` — scanne 10 fichiers du périmètre V1 pour toute nouvelle référence littérale à `xml_fill`.
- `test_pinned_sha_still_matches` — signale un drift de SHA par rapport à `11cdf466d042aece04fc6cfd13b28e1a70341b1f`, pour qu'un résultat PASS ne soit jamais interprété comme valide sur un SHA différent de celui réellement audité.

**Résultats finaux** : code arbitraire réellement exécuté = 0, subprocess = 0, réseau = 0, cloud = 0, credentials = 0, filesystem hors sandbox = 0.

**MG-2H : PASS** (critère A démontré — chemin totalement inatteignable depuis les 4 rôles V1, vérifié par analyse statique exhaustive + confirmation empirique par sentinelle + test de régression permanent).
