# NETWORK — Communications du démarrage et cas Ollama

> **Version publique (2026-11-13)** — copie anonymisée du rapport interne du 2026-10-22 : date d'installation locale retirée. Le contenu technique, les mesures et les verdicts sont inchangés ; les statuts sont ceux du 2026-10-22 (état au moment de la publication : addendum de FINAL_REVIEW.md).

Classes : LOOPBACK (127.0.0.1 / ::1) · LAN · EXTERNAL · UNKNOWN. « Historique » = mesure d'une session antérieure ;
« actuel » = mesure du 2026-10-22 dans cette mission.

## 1. Cartographie

| Moment | Initiateur | Destination | Classe | Déclencheur | Nécessaire ? | Statut après mission |
|---|---|---|---|---|---|---|
| `ollama serve` lancé par le lanceur | **Ollama** (binaire tiers), à cause de sa config par défaut `OLLAMA_NO_CLOUD=false`, `OLLAMA_REMOTES=[ollama.com]` | ollama.com (34.36.133.15:443) | EXTERNAL | automatique, ~3 s après le démarrage (« hydrate cloud model show cache ») | non pour le mode local | **maîtrisé** pour l'instance lancée par Docteur (`OLLAMA_NO_CLOUD=1`) |
| `npm run dev` (×2) | **npm** | registry.npmjs.org | EXTERNAL (au plus 1×/jour) | vérificateur de mise à jour npm | non | **maîtrisé** (`npm_config_update_notifier=false`) |
| Readiness | lanceur (Docteur) | 127.0.0.1:3001, ::1/127.0.0.1:5173 | LOOPBACK | automatique | oui | inchangé (loopback seulement) |
| Instantanés processus | lanceur (PowerShell, CIM) | aucun réseau | – | automatique | oui | nouveau, local |
| Backend au boot | Docteur | Ollama 127.0.0.1:11434, proxy egress 127.0.0.1 | LOOPBACK | automatique | oui | inchangé |
| Agents planifiés | Docteur, **configuration utilisateur** | destinations choisies par l'utilisateur | EXTERNAL possible | rattrapage 10 s après le boot puis planning | choisi par l'utilisateur | inchangé ; passe par Root Policy WEB_FETCH + garde Web Egress |
| Frontend au chargement | navigateur | 127.0.0.1:5173 / :3001 | LOOPBACK | – | oui | inchangé (aucune ressource externe dans index.html) |
| Chrome lui-même | **Chrome** (tiers) | services Google (sync, mises à jour…) | EXTERNAL | indépendant de Docteur | – | hors périmètre, documenté |
| Application de bureau Ollama (si installée/lancée par l'utilisateur) | **Ollama app** | ollama.com (updater, cloud) | EXTERNAL | indépendant de Docteur | – | non maîtrisable sans changer la config globale → documenté |

Une résolution DNS n'est pas une transmission de contenu : la résolution est faite par le service DNS Client de Windows
(svchost), non attribuable au processus ; elle n'a pas été capturée.

## 2. Mesures

### Historique (2026-10-19, autre session, même binaire Ollama, inchangé entre les deux mesures)
- `ollama.exe serve` sans réglage : connexion TLS vers 34.36.133.15:443 (ollama.com) ~3 s après le démarrage
  (`POST /api/show`, cache des modèles cloud).
- Avec `OLLAMA_NO_CLOUD=1` + `OLLAMA_HOST=127.0.0.1:11434` (+ `OLLAMA_NOPRUNE=1`) : journal « Ollama cloud disabled:
  true », écoute 127.0.0.1:11434 seulement, 0 socket non-loopback en 70 s.

### Actuel (2026-10-22) — chemin de production `startConsole(serviceConsole(...))`
- Lancement réel du Vite de Docteur + `ollama.exe serve` avec l'environnement exact du lanceur (+ `OLLAMA_NOPRUNE=1`
  ajouté pour la mesure afin de ne pas toucher au magasin de modèles), échantillonnage chaque seconde pendant 75 s de
  toutes les connexions TCP de leurs arbres de processus (cmd, conhost, npm, node vite, ollama ×2).
- Résultat : **0 EXTERNAL, 0 LAN** ; uniquement des connexions LOOPBACK (sondes du lanceur vers Vite) ; écouteurs
  `node.exe [::]:5173` et `ollama.exe 127.0.0.1:11434`.
- Run 1 : une entrée `ollama.exe -> 0.0.0.0:0` a été comptée à tort comme externe par l'échantillonneur : c'est une
  socket à l'état `Bound` (pas de connexion). L'échantillonneur a été corrigé (état TCP) ; run 2 : aucune entrée.
- Propagation de l'environnement à travers `cmd /c start → cmd /k → npm → node` : prouvée par les tests réels
  (`FAKE_PORT` transmis par `spec.env` est utilisé par le serveur factice).

Limite : un échantillonnage à 1 s peut manquer une connexion très brève ; la mesure concerne le binaire Ollama installé,
pas toutes les versions. Un mock n'est pas présenté comme preuve du comportement d'Ollama.

## 3. Contrat du mode local (ce qui est réellement garanti)

- Écoute : backend 127.0.0.1 uniquement (refus au boot sinon) ; Vite `::` + filtre loopback (handshake LAN accepté puis
  coupé — existant) ; Ollama lancé par Docteur 127.0.0.1.
- Le lanceur n'initie que du loopback.
- Ollama lancé par Docteur : pas de modèles cloud Ollama (`-cloud`) pour cette instance — compromis assumé : un modèle
  `…-cloud` (déjà classé CLOUD par `model-router.isCloudTag`, soumis à Strict Local / `cloud_enabled`) ne fonctionnera
  pas avec un Ollama démarré par le lanceur. Pour l'utiliser : lancer Ollama soi-même avant Docteur.
- Ollama absent : Docteur démarre quand même (message explicite), fonctions d'IA locale indisponibles.
- Internet coupé : le lanceur n'en dépend pas ; les fonctions web (YouTube, articles, fournisseurs cloud) échouent via la
  garde Web Egress / Strict Local existantes (tests verts).
- Non garanti par Docteur : comportement réseau de Chrome, de l'application de bureau Ollama, d'un Ollama lancé par
  l'utilisateur, et des agents planifiés configurés par l'utilisateur.

## 4. Recommandation (non appliquée, décision utilisateur)

Pour couper aussi les appels cloud d'un Ollama lancé hors de Docteur : réglage « cloud » de l'application Ollama ou
variable utilisateur `OLLAMA_NO_CLOUD=1`. Non appliqué : modification de configuration globale, interdite par la mission.
