# Agents externes — rapport du 10 septembre 2026

Le module de base est ajouté dans Paramètres → Agents externes, avec le panneau « IA · Agents externes ». Il prépare des tâches de code dans un dossier temporaire et soumet les modifications à une revue. Cette livraison ne couvre pas intégralement les 34 points du cahier des charges : FULL, l’exécution de builds/tests, les approvals interactifs d’outils et certaines garanties système restent à compléter. Aucun appel d’inférence réel n’a été effectué.

## 1. Documentation officielle vérifiée

Pages ouvertes avant l’implémentation : [Codex CLI](https://developers.openai.com/codex/cli/reference), [configuration Codex](https://developers.openai.com/codex/config-reference), [référence Claude Code](https://code.claude.com/docs/en/cli-reference), [permissions Claude](https://code.claude.com/docs/en/permissions), [sandbox Claude](https://code.claude.com/docs/en/sandboxing) et [hooks Claude](https://code.claude.com/docs/en/hooks). Les URL Codex redirigent actuellement vers learn.chatgpt.com.

Les commandes machine, l’authentification et les protections retenues sont documentées ci-dessous. Aucune utilisation d’un endpoint privé, d’une API reconstruite à partir d’une session ou d’une option de contournement.

## 2. Commandes Codex retenues

Détection : `codex --version`, `codex exec --help`, `codex login status`. L’interface affiche `codex login` à exécuter manuellement ; Docteur ne l’exécute pas.

Tâches : `codex exec --ignore-user-config --ephemeral --skip-git-repo-check --json --color never -C <stage>`, suivi de paramètres `-c` et de `-` pour le prompt sur stdin. Modèle facultatif via `--model`.

Le profil nommé `docteur` autorise seulement le dossier temporaire en lecture ou écriture, sans réseau. `approval_policy="never"` refuse les escalades en mode non interactif. Shell, unified exec, snapshots shell, apps, multi-agent, hooks, mémoire, catalogue distant, installation de dépendances de skills, recherche web et images locales sont désactivés. Aucun `danger-full-access`, `--yolo` ou bypass. Liste exacte : `commandArgs()` dans `external-agent-process.js`. [Référence de configuration](https://developers.openai.com/codex/config-reference).

## 3. Commandes Claude Code retenues

Détection : `claude --version`, `claude --help`, `claude auth status`. Connexion manuelle affichée : `claude auth login`.

Tâches : `claude -p --output-format stream-json --verbose --no-session-persistence --restricted --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}'`. Outils : `Read,Glob,Grep` en SAFE ; ajout de `Edit,Write` en EDIT. Bash, PowerShell, Agent, outils web et MCP sont refusés. Permission `default` en SAFE, `acceptEdits` dans le dossier temporaire en EDIT, après confirmation de la tâche. Modèle facultatif via `--model`. [Référence CLI](https://code.claude.com/docs/en/cli-reference).

## 4. Fichiers ajoutés/modifiés

Ajoutés :

- `cortex-server/src/lib/external-agent-policy.js`
- `cortex-server/src/lib/external-agent-process.js`
- `cortex-server/src/lib/external-agents.js`
- `cortex-server/src/routes/external-agents.js`
- `cortex-server/test-external-agents.mjs`
- `src/lib/cortex/external-agents.ts`
- `src/components/panels/ExternalAgentsPanel.tsx`
- `scripts/external-agents-harness.jsx`
- `scripts/test-external-agents-browser.mjs`
- `scripts/check-external-agents.mjs`
- `scripts/check-external-agent-artifacts.mjs`
- ce rapport.

Modifiés : `cortex-server/src/server.js`, `src/components/modals/SettingsModal.tsx` et les deux `package.json`. `dist` a été régénéré par le build. Les nombreuses modifications préexistantes ont été conservées.

## 5. Architecture

`ExternalAgents` gère previews, jobs, file d’attente, approbations, historique et revues. `external-agent-policy` valide contexte, chemins et profils ; `external-agent-process` résout et exécute les clients. Routes Hono sous `/api/external-agents/*`. Streaming SSE, limité à quatre mises à jour par seconde. La capacité déclarée est `external_code_agent`. Aucun ajout aux cascades des fournisseurs LLM.

API locale uniquement : adresse réseau, Host et Origin contrôlés ; mutations JSON. L’accès depuis un mobile/LAN est volontairement refusé.

## 6. Détection

Recherche sur les chemins absolus de PATH. Windows : `.exe` ou entrée JavaScript officielle de l’installation npm, exécutée avec Node ; aucun lancement de shim `.cmd` ou `.ps1`. Version et aide sont vérifiées. Planchers conservateurs : Codex 0.153.4 et Claude 2.1.248, complétés par une vérification des options nécessaires. Ce ne sont pas des affirmations sur la première version supportant chaque option.

## 7. Authentification

Seul le code de sortie de la commande officielle de statut est utilisé. Sa sortie n’est ni affichée ni persistée. « Prêt » signifie que le statut local réussit, pas qu’un quota ou une requête réseau a été vérifié. Aucun login automatique. Aucun état d’authentification importé dans SQLite ou le secret-store Docteur.

## 8. Sandbox

Les fichiers explicitement sélectionnés sont copiés dans un nouveau dossier `docteur-agent-*`. Le projet original n’est pas le cwd du client. Les fichiers de configuration locaux d’agent, les dossiers de données et les fichiers sensibles sont exclus. Codex reçoit également le texte des fichiers sélectionnés, car son shell est désactivé. Claude utilise ses outils de fichiers restreints.

Ces réglages demandent les protections natives aux clients ; leur application de bout en bout à une tâche authentifiée n’a pas été testée ici. Ils ne constituent pas une isolation de tout le processus officiel ni une preuve formelle d’absence de lecture par ses composants internes.

## 9. Permissions

SAFE : analyse des fichiers sélectionnés, aucune édition acceptée ; toute mutation observée invalide le job. EDIT : modifications préparées et application ultérieure après revue. Shell, commandes Git en écriture, installation, publication et déploiement sont bloqués. FULL et édition + tests sont affichés indisponibles et rejetés côté API. Générer du code de test reste possible.

## 10. Approvals

Tout envoi exige une prévisualisation puis un POST d’acceptation distinct. Le consentement porte sur le prompt, les fichiers et leur contenu ; une modification du contexte impose une nouvelle tâche. Ajouter un dossier nécessite une seconde confirmation distincte. Les éditions nécessitent une revue avant application. Le refus fonctionne sans lancer le client.

Pas de pont interactif vers les demandes d’outils des CLI : les actions qui nécessitent une escalade sont refusées. Le filtre de mots dangereux est une précaution supplémentaire, pas une sandbox de commandes. Aucun fallback automatique après échec ; l’interface propose une nouvelle tâche et une nouvelle confirmation.

## 11. Timeout

Choix UI : 5, 15 ou 30 minutes. API : 1 seconde à 30 minutes. Les probes sont limités à 10 secondes chacun. Après demande d’arrêt, une échéance de sécurité de 5 secondes borne l’attente de fermeture. Si la fermeture reste non confirmée, le job signale une erreur de nettoyage et conserve son workspace bloqué.

## 12. Annulation

Bouton Arrêter pour queued/starting/running. Windows utilise `taskkill /PID <pid> /T`, puis `/F` ; POSIX utilise le groupe de processus. Windows n’offre pas ici une séquence CTRL_BREAK avec délai de grâce complet. Les sorties déjà collectées restent visibles. SIGINT/SIGTERM du serveur déclenchent l’arrêt des jobs.

Le premier test de timeout était resté bloqué : la session a été interrompue, le chemin d’erreur de taskkill corrigé et une échéance globale ajoutée aux tests. Aucun processus supplémentaire de cette campagne ne reste actif.

## 13. Redaction

Réutilisation de `redactSecrets()` existant, complétée dans le module pour tokens nommés, cookies, Authorization, JWT et clés privées. Les fragments stdout/stderr sont assemblés par ligne avant diffusion. Les lignes trop longues sont supprimées ; les clés privées multiligne sont masquées. Sorties et résumés bornés. Les snapshots contenant un secret reconnaissable sont refusés avant copie.

La détection est heuristique : elle ne garantit pas l’identification de toute chaîne secrète arbitraire, encodée ou obfusquée.

## 14. Environnement

Liste blanche : PATH/PATHEXT, chemins système Windows, dossiers temporaires, localisation et chemins du profil nécessaires au client officiel. HOME/USERPROFILE/APPDATA sont des chemins ; Docteur ne lit pas les fichiers d’auth qu’ils peuvent contenir. Les variables de clés API, tokens applicatifs, NODE_OPTIONS et les overrides de session comme CODEX_HOME ne sont pas transmis. Aucune copie automatique de `process.env`.

## 15. Chemins et symlinks

Racines realpath autorisées en session. Refus des racines de disque, du profil entier, de ses dossiers sensibles, des chemins relatifs hors racine, ADS, noms Windows réservés, symlinks, junctions et fichiers à plusieurs liens physiques. Contrôles répétés avant lecture et application. Limites : 100 fichiers texte, 256 Kio par fichier, 2 Mio par contexte.

Snapshots en mémoire avant édition. Diff avant/après par fichier ; aucun `git reset` ou `git clean`. Vérification du contenu original avant acceptation et du contenu appliqué avant retour arrière. Un conflit préserve le travail utilisateur. Les fenêtres de course filesystem face à un autre processus local hostile ne sont pas éliminées formellement.

## 16. Historique

Historique JSON local séparé, maximum 100 jobs, sans prompt intégral ni état d’auth. Logs masqués, statut, date, durée, diff et résumés. Écriture par fichier temporaire puis renommage. Suppression de l’historique terminé dans l’UI. Les jobs nécessitant une revue ou un nettoyage sont conservés. Snapshots et autorisations de dossiers supplémentaires restent en mémoire ; revue et undo ne survivent pas au redémarrage.

## 17. Interface

Paramètres → Agents externes : installation, version, statut, Tester, instructions de connexion, agent Auto/Codex/Claude/Aucun, modèle, mode, timeout, dossier, fichiers, prompt, portée du contexte, confirmation, logs, statut, durée, exit code, résumé, diff, accepter/rejeter, retour arrière et historique. Aucun nouveau routage automatique depuis le chat.

## 18. Fonctions compatibles

Le panneau propose analyse, génération, correction, refactor, diagnostic, génération de tests et analyse des fichiers sélectionnés d’un repository. Les routes et types d’agents existants ont été inspectés ; les agents internes présents concernent surtout veille et vidéo. Aucune fonctionnalité de code existante dédiée n’a été identifiée nécessitant un branchement automatique.

## 19. Fonctions exclues

Chat, résumé vidéo, vision, embeddings, professeur, recherche générale, corpus/neurones, CV/candidatures, voix et agents internes restent sur leurs mécanismes actuels. L’API rejette les catégories incompatibles. Le mode strict local interdit préparation et lancement ; aucune donnée Cortex n’est automatiquement jointe.

## 20. Tests exécutés

| Commande | Résultat |
|---|---|
| `cd cortex-server; npm run test:external-agents` | 29/29 |
| `npm run test:external-agents` à la racine | scénario Playwright réussi |
| `node --test --test-timeout=30000 test-ai-provider-fallback.mjs` dans cortex-server | 28/38 ; 10 échecs DPAPI |
| Backend vidéo, module mocks, timeout global 30 s | 16/16 |
| `npm run test:video` à la racine | 10/10 |
| `npx tsc --noEmit` | réussi |
| `npm run build` | réussi |
| `node scripts/check-external-agent-artifacts.mjs` | 15 fichiers bundle, 0 secret reconnaissable |
| `node scripts/check-external-agents.mjs` | statut officiel minimal, aucun appel d’inférence |

## 21. Résultats et non-régression

Les tests couvrent les cas demandés : absence, détection, auth, succès, erreurs/quota, timeout, annulation et enfant, env, redaction fragmentée, chemins/junctions, SAFE/EDIT, actions bloquées, confirmation, fallback, historique, strict local, conflits et revue. Le test navigateur couvre détection, sélection Aucun, preview, consentement, arrêt et logs.

Les 10 échecs de la suite fournisseurs signalent une erreur DPAPI Protect : le profil utilisateur n’est pas chargé dans le contexte Windows du sandbox. Cette campagne ne permet donc pas de certifier toute la non-régression DPAPI. Le stockage existant n’a pas été modifié.

Pas de script lint configuré. `git diff --check` ciblé sur les fichiers existants modifiés ici passe ; le contrôle global signale des espaces de fin de ligne préexistants dans App.tsx et ReadingView.tsx. Vite émet ses avertissements de compatibilité du plugin React et de taille des chunks.

## 22. Tests réels effectués

Codex installé : 0.153.4 ; son statut indique connexion requise dans ce contexte d’exécution. Claude non trouvé sur PATH. Ce résultat ne préjuge pas de la session de l’utilisateur dans un autre terminal. De vrais processus Node et leur enfant ont été arrêtés sous Windows pour tester timeout et annulation. Aucun token n’a été consulté.

## 23. Tests non effectués

Tâche authentifiée Codex/Claude, consommation de quota, vérification native complète de leurs outils/sandbox, macOS/Linux, crash brutal du serveur, changement malveillant simultané de junction, validation complète de tous les écrans existants. Le test maintenance existant qui copie des clés de la base utilisateur n’a pas été exécuté. Aucun appel cloud ni lecture de la base personnelle pour ce module.

## 24. Limitations restantes

FULL, exécution de builds/tests, contrôles par commande avec acceptation/refus interactif, lecture Git directe, reprise/undo après redémarrage et fallback automatique configurable ne sont pas livrés. Pas de sélection native de dossier : saisie du chemin puis confirmation. Diffs complets des petits fichiers, pas de diff minimal ligne par ligne. Pas d’élévation automatique pour réparer le client ou son authentification.

## 25. Risques restants

Un crash brutal ou une terminaison forcée du serveur peut laisser un processus ou un dossier temporaire ; aucun Windows Job Object avec kill-on-close n’est encore intégré. Les clients peuvent avoir des comportements internes et des politiques administrées non couverts par les mocks. Une course locale sur le filesystem et des secrets sans signature reconnaissable restent possibles. Le mode strict local est recontrôlé avant lancement ; il n’interrompt pas une requête déjà envoyée lorsque le réglage change pendant son exécution.

Ces limites empêchent de présenter cette version comme une réalisation complète des garde-fous absolus demandés. Une validation réelle des clients et un renforcement du superviseur de processus sont nécessaires avant de revendiquer ces garanties.

## 26. Confirmation credentials

Le code Docteur ajouté ne lit, ne copie, n’affiche ni ne stocke les credentials Codex/Claude. Il ne récupère aucun token OAuth/refresh, cookie ou session et n’ajoute aucun credential à argv. Seul le client officiel gère sa propre authentification. Aucune authentification CLI n’a été lue manuellement pendant ce travail. Le scan du bundle et les tests attestent les cas reconnaissables vérifiés, sans prétendre prouver l’absence de tout secret inconnu.
