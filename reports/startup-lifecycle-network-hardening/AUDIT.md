# AUDIT — Démarrage, cycle de vie des processus et réseau (état initial)

> **Version publique (2026-11-13)** — copie anonymisée du rapport interne du 2026-10-22 : chemin local du dépôt et noms de sauvegardes remplacés par des termes génériques. Le contenu technique, les mesures et les verdicts sont inchangés ; les statuts sont ceux du 2026-10-22 (état au moment de la publication : addendum de FINAL_REVIEW.md).

Date : 2026-10-22 · Dépôt : `<dépôt>` · HEAD = origin/main = remote main = `b9eeeb4266450a34ab5625e32378c01d5be57b56`
Docteur n'était pas lancé au début de l'audit (ports 3001 / 5173 / 11434 libres, pas d'Ollama).

## 1. Chaîne de lancement réelle (avant correction)

```
Bureau : Docteur-Launcher.lnk ──► <dépôt>\Docteur-Launcher.bat (cmd.exe, menu)
  [1] MODE_PC
   ├─ :FREE_PORTS
   │    ├─ 5173 : netstat → PID ; `wait-for-frontend.mjs --identify` (HTTP seul) → taskkill /PID /F
   │    └─ 3001 : netstat → PID → taskkill /PID /F   ◄── AUCUNE vérification d'identité
   ├─ tasklist ollama.exe ? sinon start "Ollama" cmd /k "ollama serve" + timeout 4 s (aveugle)
   ├─ start "Cortex Server" cmd /k "cd /d …\cortex-server && npm run dev"
   │      cmd /k → npm (node npm-cli.js) → cmd /d /s /c → node --watch-path=src … src/server.js
   │                                                     └─► node --watch-preserve-output src/server.js  (écoute 127.0.0.1:3001)
   ├─ node scripts/wait-for-cortex.mjs   (GET /api/ping 200 sur 127.0.0.1:3001, http puis https, 120 s)
   │      échec → `goto MENU` → `cls`  ◄── le message d'erreur est effacé
   ├─ start "Docteur Frontend" cmd /k "cd /d <dépôt> && npm run dev"
   │      cmd /k → npm → cmd /d /s /c vite → node "<repo>\node_modules\.bin\\..\vite\bin\vite.js"  (écoute [::]:5173)
   ├─ node scripts/wait-for-frontend.mjs (STARTUP-1 : HTTP 200 + titre Docteur, 60 s) → échec → :STARTUP_STOPPED (pause)
   └─ start chrome --app=http://localhost:5173 ; timeout 3 ; exit
```

| Étape | Script | Processus créé | Port | Succès | Échec | Timeout |
|---|---|---|---|---|---|---|
| Menu | Docteur-Launcher.bat | cmd.exe | – | choix 1 | – | – |
| Ports | :FREE_PORTS | taskkill | 3001/5173 | port libéré | 5173 étranger → arrêt | aucun |
| Ollama | .bat | cmd /k + ollama.exe serve | 11434 | – (non vérifié) | console d'erreur | 4 s aveugle |
| Backend | .bat + wait-for-cortex | cmd /k → npm → node --watch → node server | 127.0.0.1:3001 | `/api/ping` 200 (n'importe quel processus) | 120 s → `cls` | 120 s |
| Frontend | .bat + wait-for-frontend | cmd /k → npm → cmd → node vite | [::]:5173 | 200 + titre Docteur | → pause | 60 s |
| Navigateur | .bat | chrome | – | – | – | – |

Fermeture : rien n'est arrêté à la fermeture de Chrome ; les consoles « Cortex Server » / « Docteur Frontend » / « Ollama »
hébergent les services (fermer une console = arrêter son service). Un crash laisse sa console ouverte (cmd /k) avec le
diagnostic.

## 2. Ports et adresses d'écoute (code, vérifié)

| Port | Composant | Adresse | Preuve |
|---|---|---|---|
| 3001 | backend Cortex | `127.0.0.1` uniquement ; `LOCAL_NETWORK=true` ou HOST non-loopback = refus au boot | `lan-exposure-policy.js` `resolveApiBindHost` ; test-sec3 |
| 5173 | Vite dev | `::` (double pile, toutes interfaces) + plugin qui détruit toute connexion non-loopback, `strictPort` | `vite.config.ts` (`host: '::'`, `loopbackOnlyPlugin`) |
| 11434 | Ollama (si lancé par le lanceur) | défaut Ollama 127.0.0.1 ; une variable utilisateur `OLLAMA_HOST` pouvait l'élargir | `ollama serve` |
| éphémère | proxy media-egress (yt-dlp) | 127.0.0.1 | `media-egress.js` |
| configurable | kiwix-serve (enfant du backend) | `--address=127.0.0.1 --blockexternal` | `kiwix.js` |
| RASSILON LAN | écouteur TLS dédié | restauré uniquement si activé explicitement auparavant | `restoreRassilonLanServer` |

Constat 5173 : la poignée de main TCP depuis le LAN aboutit puis la socket est détruite (aucune donnée servie). Existant,
non élargi, documenté comme limite.

## 3. Phase A — risque port 3001 (CONFIRMÉ)

- `Docteur-Launcher.bat` lignes 300-303 (HEAD) : `for /f … netstat -ano | findstr ":3001 .*LISTENING" do taskkill /PID %%I /F`.
- Critère d'arrêt = « écoute sur 3001 ». Aucune lecture de ligne de commande, d'exécutable, de point d'entrée, de dépôt,
  aucune revérification avant l'arrêt, `/F` immédiat. Tout programme sur 3001 (Grafana, un autre serveur Node, une API de
  dev…) était tué. Un PID lu par netstat pouvait aussi avoir été réutilisé entre la lecture et `taskkill`.
- Toute adresse d'écoute était ciblée (0.0.0.0, [::], adresse LAN), pas seulement celle du backend (127.0.0.1).
- Côté serveur, `port-preflight.js` existait déjà (classe cortex / inconnu, ne tue jamais) — mais le lanceur avait déjà
  tué l'occupant avant que le serveur ne démarre.
- 5173 (STARTUP-1) : arrêt après une simple réponse HTTP contenant le titre Docteur → une réponse HTTP n'est pas une preuve
  de propriété (autre checkout de Docteur, page copiée, PID réutilisé entre netstat et taskkill).

## 4. Phase B — démarrage

- `wait-for-cortex.mjs` : « prêt » = n'importe quel HTTP 200 sur `/api/ping` (aucune vérification d'identité, essaie aussi
  https), aucune détection de crash : un backend mort pendant le boot faisait attendre 120 s.
- Échec backend → `goto MENU` → `cls` : le message disparaissait (confirmé, lignes 73 → 6).
- Ollama : attente aveugle de 4 s, aucun statut réel.
- Budgets historiques : backend 120 s (un cold boot de 91 s observé une fois le 2026-10-21, warm 4-6 s — mesures
  historiques STARTUP-1, non re-mesurées ici, voir §7) ; frontend 60 s.
- **Nouveau constat mesuré (2026-10-22)** : la sonde frontend STARTUP-1 a un délai de 2 s par requête. Le vrai Vite a mis
  3-4 s par réponse sous charge : la sonde abandonnait chaque requête et ne voyait jamais « prêt » en 60 s (run 2 :
  `ready was false`; sondes suivantes `TIMEOUT 4009 ms | TIMEOUT | ready 3081 ms`). Sans charge : prêt en 3,2 s.

## 5. Phase C — cycle de vie

- Relance à chaud : `:FREE_PORTS` tuait seulement les PID d'écoute → les consoles `cmd /k`, `npm` et le superviseur
  `node --watch` restaient → consoles abandonnées, et le `node --watch` orphelin redémarrait un serveur au prochain
  changement de fichier.
- Deux lanceurs simultanés : aucun verrou → deux backends possibles contre la même base (le second refusé par
  `port-preflight` seulement s'il arrive après l'écoute du premier) ; second Vite refusé par `strictPort` → console d'erreur.
- Un backend en cours de démarrage (pas encore à l'écoute) était invisible pour le lanceur.
- Le titre des consoles n'est pas fiable : le shim `vite.cmd` exécute `title %COMSPEC%`.
- `lib/browser.js` : le backend peut lancer le navigateur de l'utilisateur → un Chrome peut être **descendant** du backend.
  Un arrêt d'arbre (`taskkill /T`) du backend pourrait fermer le navigateur de l'utilisateur.

## 6. Phase D — réseau (voir NETWORK.md)

- Lanceur : `ollama serve` sans configuration → Ollama 0.24 contacte `ollama.com` ~3 s après le démarrage
  (« hydrate cloud model show cache », mesure historique 2026-10-19, 34.36.133.15:443).
- `npm run dev` (×2) : vérificateur de mise à jour npm (requête registry.npmjs.org, au plus 1×/jour).
- Backend au boot : aucun appel externe automatique trouvé (client Ollama local, proxy egress loopback, `yt-dlp --version`
  local). Agents planifiés **créés par l'utilisateur** : rattrapage 10 s après le boot, via la garde Web Egress.
- Frontend au chargement : aucune ressource externe (index.html sans URL externe ; CSP existante).

## 7. Limites de l'audit

- Pas de démarrage réel du backend : 30 sauvegardes présentes, aucune du 2026-10-22 → un boot aurait créé la sauvegarde du
  jour et **supprimé la plus ancienne sauvegarde** (rotation à 30). Le backend ne peut pas être isolé de `data/`.
- Pas de capture DNS (résolution faite par le service DNS Client de Windows, non attribuable au processus).
