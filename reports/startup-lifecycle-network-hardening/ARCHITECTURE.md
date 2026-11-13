# ARCHITECTURE — STARTUP-2 (lanceur, identité des processus, cycle de vie, réseau)

> **Version publique (2026-11-13)** — copie anonymisée du rapport interne du 2026-10-22. Le contenu technique, les mesures et les verdicts sont inchangés ; les statuts sont ceux du 2026-10-22 (état au moment de la publication : addendum de FINAL_REVIEW.md).

## 1. Vue d'ensemble

```
Docteur-Launcher.bat  [1] Mode PC
  └─ node scripts/docteur-launch.mjs           ← machine à états, dépendances injectées (testable)
        ├─ scripts/launcher-identity.mjs       DÉTECTER (1 instantané PowerShell lecture seule) · CLASSIFIER (JS pur)
        │                                      · AGIR (seul arrêt possible, épinglé + revérifié)
        ├─ scripts/launcher-lock.mjs           verrou de lancement par utilisateur Windows
        └─ scripts/wait-for-frontend.mjs       sonde HTTP STARTUP-1 réutilisée (titre Docteur)
  exit 0  → start chrome --app=http://localhost:5173
  exit ≠0 → :STARTUP_STOPPED (pas de cls, pause, Chrome non ouvert)
```

États : `PREFLIGHT → PORT_CHECK → OLLAMA → BACKEND_STARTING → BACKEND_READY → FRONTEND_STARTING → FRONTEND_READY →
BROWSER_OPENING`, ou `FAILED` ; `STOPPING` uniquement lors d'un remplacement accepté. Chaque transition est journalisée
(`%LOCALAPPDATA%\Docteur\launcher\launcher.log`, codes et PID seulement, aucune ligne de commande, rotation 256 Ko).

Ordre volontaire : **3001 ET 5173 sont classés avant de démarrer quoi que ce soit.** Un 5173 étranger n'entraîne donc
jamais un backend démarré pour rien. 5173 est reclassé juste avant le lancement du frontend (il a pu changer pendant
l'attente du backend).

## 2. Modèle d'identité (`launcher-identity.mjs`)

Instantané : tous les écouteurs des ports demandés (`Get-NetTCPConnection -State Listen`) + tous les processus
(`Win32_Process` : pid, parent, nom, date de création en FILETIME). Lignes de commande lues **uniquement** pour
`node.exe` et `cmd.exe`. Toute erreur de lecture = `PROCESS_PROBE_FAILED`, jamais « libre ».

| État | Condition |
|---|---|
| `FREE` | aucun écouteur sur le port |
| `DOCTEUR_BACKEND_CONFIRMED` | écouteur unique, `node.exe`, entrée `src/server.js` (relative) ou `<dépôt>\cortex-server\src\server.js`, rôle serveur (pas `--watch`), **ancré au dépôt**, adresse 127.0.0.1/::1 |
| `DOCTEUR_FRONTEND_CONFIRMED` | `node.exe` `<dépôt>\node_modules\vite\bin\vite.js` sans sous-commande (serveur dev), ancré, adresse ::/::1/127.0.0.1 |
| `FOREIGN_PROCESS` | non-node, autre programme Node, PID système (0/4) |
| `UNKNOWN_OWNER` | ligne de commande illisible (autre utilisateur / élevé), entrée Docteur non ancrée (lancée à la main, autre checkout), mauvais rôle/port, écoute non-loopback |
| `INCONSISTENT_STATE` | plusieurs propriétaires, propriétaire absent de la liste des processus, écouteur changé entre deux observations |

**Ancrage au dépôt** : chemin absolu dans le dépôt, OU un ancêtre `cmd.exe` dont la ligne de commande est exactement la
console du lanceur `cd /d "<dépôt>[\cortex-server]" && npm run dev` (frontière stricte : `Docteur2`, `cortex-server2`,
`&& evil`, `dev:local` refusés). La remontée parent (≤ 6 sauts) n'accepte un parent que si **sa date de création ≤ celle
de l'enfant** : un PID parent recyclé casse la chaîne. Chaîne réelle observée :
`server ← node --watch ← cmd /d /s /c ← npm ← cmd /s /k "cd /d … && npm run dev"` (4 sauts).

Jamais une preuve à elle seule : PID, port, nom d'image, titre de fenêtre, réponse HTTP.
La réponse HTTP est une condition **supplémentaire** (santé), pas une identité.

## 3. Décisions (port 3001)

| Situation | Décision |
|---|---|
| libre, aucun processus backend | démarrer |
| libre, backend Docteur ancré en cours de démarrage | **attendre** (aucun doublon) |
| libre, seul un `node --watch` orphelin (serveur crashé) | démarrer + informer (rien n'est fermé) |
| confirmé et répond | **réutiliser** |
| confirmé, ne répond pas | attendre jusqu'à 45 s (un parse Kiwix synchrone a bloqué ~22 s) en revérifiant l'écouteur |
| confirmé, toujours muet | demander à l'utilisateur (O/N, 60 s, défaut N, pas de console = N) → remplacement contrôlé |
| étranger / inconnu / incohérent | refus, aucun arrêt, aucun démarrage, Chrome fermé |

### Remplacement contrôlé (seule terminaison du lanceur)
1. Cibles = le serveur à l'écoute + son parent `node --watch` s'il est vérifié (sinon il relancerait le serveur au prochain
   changement de fichier). **Jamais les descendants** (le backend peut avoir lancé le navigateur de l'utilisateur via
   `lib/browser.js`, kiwix-serve, ffmpeg…), jamais la console, jamais npm.
2. PowerShell **épingle** chaque cible (`GetProcessById` + `.Handle` : Windows ne recycle pas un PID tant qu'un handle est
   ouvert), puis refait un instantané complet **pendant l'épinglage**.
3. Node reclasse cet instantané avec le même code : même port, même PID, même date de création, mêmes cibles → `GO`,
   sinon `ABORT` (rien n'est arrêté).
4. Arrêt par les handles épinglés (`Process.Kill()`), pas de `taskkill`, pas d'arbre, pas de nom d'image.
5. Vérification : 3001 doit redevenir `FREE` en ≤ 20 s, sinon `BACKEND_PORT_NOT_RELEASED` (aucun nouveau backend).

## 4. Port 5173

Jamais d'arrêt. Interface Docteur confirmée qui répond → réutilisée ; muette 15 s → `FRONTEND_UNRESPONSIVE` (fermer la
fenêtre). Étrangère / inconnue → refus avant tout démarrage. L'ancien arrêt STARTUP-1 « après réponse HTTP » est supprimé
(une réponse HTTP n'est pas une preuve de propriété) ; la porte HTTP STARTUP-1 (200 + titre) est conservée comme
condition de disponibilité.

## 5. Readiness et budgets

- Backend prêt = `/api/ping` → 200 + `{"ok":true}` sur 127.0.0.1:3001 **ET** écouteur `DOCTEUR_BACKEND_CONFIRMED`.
- Frontend prêt = HTTP 200 + titre Docteur (STARTUP-1) **ET** écouteur `DOCTEUR_FRONTEND_CONFIRMED`.
- Budgets inchangés : backend 120 s (aligné sur `wait-for-cortex.mjs` et l'écran de démarrage ; cold boot 91 s observé),
  frontend 60 s. Délai par requête : frontend 10 s, ping 5 s (mesure du 2026-10-22 : 3-4 s par réponse Vite sous charge).
- Pendant l'attente, instantané toutes les 4 s : crash du serveur (le `node --watch` reste seul, 2 observations) →
  `BACKEND_CRASHED` immédiat ; processus disparu → `*_EXITED` ; jamais apparu en 20 s → `*_PROCESS_NOT_FOUND` ; autre
  programme sur le port → `*_PORT_TAKEN`.
- Progression : étape, secondes écoulées, maximum (toutes les 10 s). Aucun pourcentage inventé.

## 6. Verrou de session (`launcher-lock.mjs`)

`%LOCALAPPDATA%\Docteur\launcher\launch.lock`, par utilisateur Windows. Création atomique (fichier temporaire complet puis
`link` qui échoue si le verrou existe). Propriétaire = PID + date de création du processus `docteur-launch.mjs`.
Périmé (propriétaire disparu ou PID recyclé, ou illisible depuis > 2 min) → récupéré par renommage atomique ; si le
fichier déplacé n'est pas celui jugé périmé, il est remis en place. Libération uniquement de son propre verrou. Le verrou
n'est **jamais** une preuve pour arrêter quoi que ce soit. Multi-utilisateurs : les processus d'un autre utilisateur ont
une ligne de commande illisible → `UNKNOWN_OWNER` → refus.

## 7. Contrat de fermeture

- Fermer l'onglet/fenêtre Chrome : les services restent actifs ; relancer le raccourci les **réutilise** (pas de doublon).
- La fenêtre du lanceur se ferme seule après succès ; sur échec, elle reste ouverte (pause) avec le diagnostic.
- Arrêter Docteur : fermer les fenêtres « Cortex Server » et « Docteur Frontend » (ou Ctrl+C). Ollama n'est jamais fermé
  par Docteur.
- Crash : la console du service reste ouverte avec l'erreur ; au lancement suivant, elle est signalée (« ancienne fenêtre
  sans service actif ») mais jamais fermée automatiquement.
- Chrome n'est jamais fermé ni inspecté par le lanceur.

## 8. Réseau

- Consoles backend/frontend : `npm_config_update_notifier=false` (paramètre npm officiel, portée = ces consoles).
- Ollama lancé **par Docteur** uniquement : `OLLAMA_NO_CLOUD=1`, `OLLAMA_HOST=127.0.0.1:11434` (paramètres Ollama
  officiels, portée = cette console). Un Ollama déjà lancé par l'utilisateur est utilisé tel quel, jamais reconfiguré.
- Le lanceur ne parle qu'à 127.0.0.1 / ::1 (test statique).

## 9. Injection de commande

Les commandes de console sont des constantes ; seuls le chemin du dépôt et celui d'`ollama.exe` y sont insérés, après
validation `^[A-Za-z]:\\[^"%&|<>^!]*$` (sinon refus). Les scripts PowerShell sont fixes ; les seules données insérées sont
des entiers de port validés et une liste `pid` validée `^[0-9]+(,[0-9]+)*$` passée par variable d'environnement.
