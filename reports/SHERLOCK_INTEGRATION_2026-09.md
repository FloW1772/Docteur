# SHERLOCK — certification du 17 septembre 2026

**SHERLOCK INTEGRATION : PARTIEL.** L'intégration fonctionnelle et les protections applicatives testées passent. Le confinement d'un processus Python compromis au niveau natif n'est pas garanti par une sandbox Windows système. Aucun PASS global de sécurité n'est revendiqué.

## Provenance

Canonical repo : https://github.com/sherlock-project/sherlock

Pinned SHA : `a38ba54fda799cd786a2ab67a50143e1a63169e6` (v0.16.2).

Licence : MIT. L'audit initial, terminé avant installation/import/exécution, est conservé dans [SHERLOCK_AUDIT_2026-09.md](SHERLOCK_AUDIT_2026-09.md). Sources téléchargées et inventoriées dans `external/Sherlock-source/<SHA>/`. Les modules runtime et la base sont vérifiés par hash avant chaque recherche ; aucune branche flottante.

Base : `sherlock_project/resources/data.json`, acquisition 2026-09-17, SHA256 `3fdfc6694c5cd99798881215554b09e617c6d5284a6219fae309882566a9fb30`. Aucun téléchargement de base, exclusion distante ou contrôle de version upstream pendant les recherches. Une mise à jour exige explicitement un nouvel audit, nouveau pin/hash et nouvelle certification.

## Installation et environnement

Python 3.10 dans `external/Sherlock-runtime/venv`, aucun package global. Installation initiale de wheels seulement, puis installation offline avec `--no-index --no-deps` et `pip check` réussi. Les 17 wheels sont inventoriées avec SHA256 dans `cortex-server/src/lib/sherlock-pin.json` et `external/Sherlock-runtime/dependency-lock.json` ; leur égalité et chaque hash ont été revérifiés. `stem`, inutilisé par le chemin runtime retenu, n'est pas installé. Pas d'audit exhaustif des binaires natifs ni de garantie d'absence de vulnérabilités transitives.

Le script opérateur `node scripts/setup-sherlock.mjs` refuse un runtime existant. La version finale utilise les versions exactes et `--require-hashes`, uniquement PyPI et des wheels. Ce script final a été vérifié syntaxiquement ; le chemin d'installation initial, les artefacts et leurs hashes ont été vérifiés, sans supprimer/réinstaller inutilement l'environnement. Il suppose Python 3.10 Windows à l'emplacement documenté dans le script et les sources auditées présentes. Aucune installation depuis une route ou au démarrage. Le runtime et son HOME d'installation sont ignorés par Git.

Pour chaque job : `cortex-server/data/sherlock-workspaces/<UUID>/`, HOME/USERPROFILE/HOMEDRIVE/HOMEPATH/APPDATA/LOCALAPPDATA et TEMP/TMP dédiés. Environnement construit explicitement, aucune copie globale de `process.env`, aucun token, proxy, cookie, configuration cloud/SSH/Git ou navigateur transmis. Python lancé avec `-I -B`, `shell:false`, argv fixe ; username en JSON sur stdin uniquement.

## Gateway et protections

- `sherlock-policy.js` : username exact, 1–64 caractères, lettres/nombres Unicode et `_.-`, premier caractère lettre/nombre/underscore, pas de `..`, contrôle, espace, option ou chemin. Pas de trim silencieux.
- `sherlock-gateway.js` : API `searchUsername({username, timeoutMs, siteFilter})`. Aucun exécutable, argument brut, URL, chemin ou configuration fourni par l'appelant.
- `sherlock_runner.py` importe uniquement la fonction de recherche épinglée. Aucun appel de CLI/main, mise à jour, export, navigateur, Tor ou shell.
- Le processus demande ses requêtes par protocole JSON ; Docteur vérifie leur correspondance avec les probes de la base épinglée. GET/HEAD seulement, sans cookies/Authorization/proxy hérité. Les entêtes de la base sont supprimés.
- DNS : toutes les adresses doivent être publiques, connexion attachée à une adresse validée ; contrôle renouvelé à chaque redirection. Localhost, LAN, link-local, metadata, IPv4-mapped IPv6, NAT64 et schémas autres que HTTP(S) refusés. Politique IPv6 volontairement conservatrice. DNS borné et annulation immédiate de l'attente ; un lookup système déjà lancé peut se terminer sans déclencher de connexion.
- Résultats structurés `site, username, profileUrl, status, responseTime, metadata`. Statuts `found/absent/invalid/error`, metadata `untrusted:true`. Les URLs sont reconstruites par Docteur à partir de la base, jamais acceptées depuis le résultat enfant. Aucun HTML distant, stack, stderr ou instruction injecté dans les agents.
- L'ancienne route d'import en neurone répond 410. Aucun enregistrement de Sherlock comme outil brut Cortex/MetaGPT ; la façade applicative passe par Docteur.
- Chemins contrôlés contre sorties de racine et junctions/symlinks, y compris les ancêtres. L'audit Python bloque les ouvertures hors des racines runtime/workspace, les écritures hors workspace, sockets et créations de processus via les API auditées.

Limites : 1 job actif, 3 démarrages/minute pour l'utilisateur local (quota global au serveur), 30 sites maximum, GitHub/Reddit/GitLab par défaut si présents dans la base ; requêtes sérialisées et espacées de 250 ms, 8 s par requête, 3 redirections maximum, 120 s maximum par mission (borne personnalisable), 128 Kio de stdout+stderr, 512 Kio par réponse HTTP, historique mémoire de 100 jobs. Quotas/historique réinitialisés au redémarrage. Pas de recherche exhaustive sur tous les sites par défaut.

Cancel/timeout : AbortController côté broker et arrêt de l'arbre Python avec l'exécutable système `taskkill.exe /PID <pid> /T /F`, sans shell Windows. Le slot n'est libéré qu'après clôture du processus ; arrêt gracieux du serveur relié au shutdown. Un arrêt brutal du serveur n'est pas couvert par un Job Object Windows.

## Routes et interface

`POST /api/sherlock/search`, `GET /api/sherlock/jobs/:id`, `POST /api/sherlock/jobs/:id/cancel`. Loopback de la connexion, Host et Origin locaux, JSON validé, champs supplémentaires refusés, corps limité à 4096 octets. Erreurs normalisées et logs avec identifiant de job seulement. Pas d'API de commande brute. Anciennes URLs `/search/:id` limitées à la même gateway ; installation/désinstallation HTTP refusées.

Paramètres → Modèles → Sherlock : pseudonyme, état, durée, sites, trouvés/absents/erreurs, liens publics et annulation. Centre d'aide → Sherlock → Ouvrir mène à cet onglet. Pas de commande Python, chemin venv, environnement, stack ou secret dans l'interface. Une recherche transmet explicitement le pseudonyme aux sites publics ; une correspondance ne prouve pas l'identité d'une personne. Aucun export automatique vers un neurone ou prompt.

## Vérifications

- `node scripts/test-connectors-certification.mjs` : première passe **661/661**, aucune erreur/skip/annulation. Deux tests Sherlock supplémentaires ensuite ajoutés et validés ; passe finale consignée dans `connectors-certification-results.json`.
- `node --test cortex-server/test-phase7-sherlock.mjs` (depuis le répertoire serveur avec le nom de fichier relatif) : **54/54**. Vrai import/exécution Python, transport HTTP simulé pour les scénarios adverses : username normal/Unicode/espaces/options/contrôles/traversal, base privée/file, DNS privé/mixte, redirect localhost, réponse volumineuse, quota, concurrence, erreur réseau expurgée, arrêt réel/cancel/timeout sans PID restant, stdout massif, environnement filtré, junction, limites API et données normalisées.
- `external/Sherlock-runtime/venv/Scripts/python.exe -I -B scripts/test-sherlock-guard.py` : **9/9**. Refus effectif socket, subprocess, os.system, lecture HOME/.ssh et .env, listing HOME, écriture externe/traversal ; écriture autorisée dans le workspace. Les commandes refusées ne sont pas lancées.
- `node scripts/test-sherlock-browser.mjs` : **10/10**, Chromium réel, API simulée. Navigation depuis le Centre d'aide, validation avant envoi, compteurs/durée/lien, Unicode conservé, annulation, zéro erreur navigateur. Les premiers essais du harness ont échoué sur temps de compilation puis encodage du test ; corrigés avant résultat final.
- Recherche réelle unique via gateway : pseudonyme fictif `docteur-cert-7f39a2b841e6`, filtre GitHub, délai 15 s : `done`, 1 site, `absent`, 1142 ms, aucune erreur. Aucun compte personnel ni profil existant ciblé.
- `npm run build` : **PASS**, inclut `tsc` puis Vite/PWA. Avertissements de dépréciation Vite et taille de chunks préexistants, non bloquants. `git diff --check` : PASS.

## Résultat demandé

| Contrôle | Résultat |
| --- | --- |
| Sandbox | **FAIL pour une garantie système complète** ; PASS des gardes applicatifs testés |
| Credential isolation | PASS : environnement explicite et lectures sensibles refusées dans le périmètre testé |
| Network policy | PASS pour le broker et les API Python auditées |
| Private network blocked | PASS : localhost/LAN/link-local/metadata et redirects testés |
| Shell | 0 exécution ; `shell:true`, cmd.exe, PowerShell, Bash : 0 dans le chemin runtime Sherlock |
| Raw command API | 0 |
| Timeout | PASS |
| Cancel | PASS |
| Orphan process | 0 après les arrêts/cancel/timeouts testés |
| UI | PASS |
| Help Center | PASS |
| Typecheck | PASS |
| Build | PASS |
| SHERLOCK INTEGRATION | **PARTIEL** |

Les compteurs shell/credentials/HOME concernent le chemin d'exécution Sherlock testé, pas les commandes opérateur de préparation dans PowerShell. Les tests d'attaques refusées ne signifient pas qu'un secret a été lu ou un shell lancé.

## Limite qui empêche un PASS global

`sys.addaudithook` et la substitution de Requests sont des gardes applicatifs, pas une frontière de sécurité du système d'exploitation. Les bibliothèques natives sont chargées avant les hooks ; du code natif compromis pourrait contourner ceux-ci. Le processus conserve l'identité Windows du serveur, sans AppContainer, jeton restreint/ACL dédiées ou isolation VM, ni pare-feu système attaché au processus. Le pin protège contre une modification du code audité détectée au lancement, pas contre toute compromission native ou course avec un autre processus du même utilisateur. Les agents ayant indépendamment un shell sous le même compte Windows ne peuvent pas être interdits au niveau OS d'accéder à ces fichiers par cette seule intégration.

Il faudrait une isolation système séparée et sa certification adversariale pour garantir ces interdictions face à un composant entièrement compromis. La livraison actuelle est donc certifiée **partiellement**, sans présenter le venv ou les audit hooks comme une sandbox inviolable. Aucun privilège administrateur, règle pare-feu globale ou changement de sécurité Windows n'a été ajouté.

MG-6 et les travaux préexistants conservés. Aucun commit, déploiement ni démarrage d'une recherche de fond. Arrêt de cette mission après certification.
