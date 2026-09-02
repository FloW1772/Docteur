# Docteur Voice

Petite application native (Rust + Tauri), qui vit dans la barre des taches
Windows, pour dicter une note ou un "à faire" vers Docteur **même quand
l'onglet/le navigateur est fermé**. Pas de fenêtre, empreinte mémoire minimale
au repos.

Elle est **totalement séparée** du code de Docteur — aucun fichier de
`cortex-server/` ou `src/` n'a été modifié pour ce projet. Le seul lien avec
Docteur, ce sont deux chemins que *vous* configurez :
- le dossier `cortex-server/data/inbox/` (dépôt de fichier, mécanisme déjà
  existant dans Docteur, jamais touché ici) ;
- optionnellement l'API locale de `cortex-server` (`http://127.0.0.1:3001`),
  seulement pour les "à faire", et seulement si le serveur tourne.

## Pourquoi Tauri + whisper.cpp (et pas autre chose)

- **Tauri** plutôt qu'Electron : binaire natif largement plus léger (quelques
  Mo contre ~100+ Mo), webview système (WebView2, déjà présent sur Windows
  10/11), empreinte mémoire au repos bien inférieure — pertinent puisque
  l'app tourne en permanence dans la barre des taches.
- **whisper.cpp en processus externe** plutôt que `whisper-rs` (bindings
  Rust liés statiquement) ou l'API de reconnaissance vocale de Windows :
  - `whisper-rs` compile whisper.cpp *dans* ce binaire via CMake/un
    compilateur C++ — une étape de build lourde et fragile pour un petit
    utilitaire, et qui grossit le binaire final.
  - L'API native Windows (`Windows.Media.SpeechRecognition`) nécessite des
    bindings COM/WinRT plus complexes à intégrer correctement côté Rust, pour
    une qualité de reconnaissance moins prévisible (dépend du pack de langue
    installé) que Whisper.
  - Lancer `whisper-cli.exe` (le CLI officiel précompilé de whisper.cpp) en
    **sous-processus, avec des arguments passés en tableau** (jamais une
    chaîne shell) est exactement le même schéma déjà utilisé par
    `cortex-server` pour `yt-dlp`/Whisper (`spawn`/`execFile`, jamais
    `exec` avec concaténation) — cohérent avec le reste du projet, aucune
    injection de commande possible, et le modèle (150 Mo à 3 Go selon la
    taille choisie) reste un fichier externe téléchargé une fois, jamais
    embarqué dans l'app.

Le compromis : une étape d'installation manuelle du CLI whisper.cpp + d'un
modèle GGML (voir plus bas), au lieu d'un "tout-en-un". Le micro n'est capturé
qu'à la demande (raccourci clavier) via [`cpal`](https://docs.rs/cpal), et
whisper-cli n'est invoqué que sur l'enregistrement obtenu — rien ne tourne en
permanence.

## Architecture

```
docteur-voice/
  src-tauri/
    Cargo.toml
    tauri.conf.json         # app tray-only (aucune fenêtre), plugins déclarés
    capabilities/default.json
    icons/                   # icônes générées (voir Installation)
    src/
      main.rs                # tray, raccourci global, orchestration
      config.rs               # config.json (chemin, hors dépôt git)
      audio.rs                 # capture micro → fichier WAV (cpal + hound)
      transcribe.rs             # appelle whisper-cli.exe (sous-processus)
      intent.rs                  # texte → Note / A faire / Ouvrir Docteur
      inbox.rs                    # dépose un .json dans l'inbox de Docteur
      api.rs                       # POST http://127.0.0.1:3001/api/todo (localhost uniquement)
  config.example.json
  README.md (ce fichier)
```

## Installation

### 1. Prérequis

- **Rust** (édition 2021+) : https://rustup.rs
- **Tauri CLI** : `cargo install tauri-cli --version "^2"`
- Sur Windows, les [prérequis Tauri standards](https://v2.tauri.app/start/prerequisites/)
  (WebView2 — déjà présent sur Windows 10/11 à jour ; Visual Studio Build
  Tools pour le linker MSVC).

### 2. whisper.cpp (transcription locale)

1. Téléchargez une release précompilée de whisper.cpp pour Windows (CLI) :
   https://github.com/ggml-org/whisper.cpp/releases — cherchez un artefact
   contenant `whisper-cli.exe` (ou `main.exe` selon la version).
2. Téléchargez un modèle GGML, par exemple `ggml-base.bin` (~150 Mo, bon
   compromis vitesse/qualité pour du français) ou `ggml-small.bin` (plus
   précis, plus lent) :
   https://huggingface.co/ggerganov/whisper.cpp/tree/main
3. Placez les deux fichiers où vous voulez (ex. `C:\whisper\`), vous
   renseignerez leur chemin exact dans `config.json` (étape 4).

### 3. Icônes de l'application

Un script Python a déjà généré une icône source de base
(`src-tauri/icons/icon-source.png`, un simple disque — à remplacer par votre
propre icône si vous le souhaitez, même nom de fichier). Générez le jeu
d'icônes complet attendu par Tauri :

```bash
cd docteur-voice
cargo tauri icon src-tauri/icons/icon-source.png
```

Cela produit `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico`,
`icon.icns` dans `src-tauri/icons/` (déjà référencés dans `tauri.conf.json`).
Les icônes de la zone de notification (`tray-idle.png` / `tray-listening.png`,
un point bleu / rouge) sont déjà prêtes, pas besoin de les régénérer.

### 4. Compiler et lancer

```bash
cd docteur-voice
cargo tauri dev      # mode développement
# ou
cargo tauri build    # installeur NSIS dans src-tauri/target/release/bundle/nsis/
```

Au tout premier lancement, l'app écrit un fichier de configuration dans
`%APPDATA%\docteur-voice\config.json` (voir `config.example.json` pour un
modèle) et affiche une notification pour vous rappeler de le compléter.
Éditez-le avec un éditeur de texte :

```json
{
  "inbox_dir": "C:\\dev\\Docteur\\cortex-server\\data\\inbox",
  "docteur_url": "http://localhost:5173",
  "api_base": "http://127.0.0.1:3001",
  "hotkey": "Ctrl+Alt+D",
  "whisper_cli_path": "C:\\whisper\\whisper-cli.exe",
  "whisper_model_path": "C:\\whisper\\ggml-base.bin",
  "language": "fr",
  "launch_at_startup": false
}
```

Redémarrez l'app après avoir édité `config.json` (menu clic droit > Quitter,
puis relancez) pour que les changements soient pris en compte — il n'y a pas
de fenêtre de réglages, volontairement, pour rester minimaliste.

## Utilisation

- **Icône dans la barre des taches** (zone de notification, en bas à droite) :
  clic droit pour le menu (Écoute activée/désactivée, Ouvrir Docteur, Lancer
  au démarrage de Windows, Quitter).
- **Raccourci global** (`Ctrl+Alt+D` par défaut, configurable) : premier
  appui démarre l'écoute (icône de la zone de notification passe au rouge +
  notification), deuxième appui arrête l'enregistrement, transcrit, détecte
  l'intention et agit — avec une notification de confirmation.
- **Ce que vous dictez** :
  - `"note [contenu]"` ou n'importe quel texte libre sans mot-clé reconnu →
    déposé comme note dans l'inbox de Docteur.
  - `"à faire [contenu]"` / `"rappelle-moi [de] [contenu]"` → ajouté à la
    liste "À faire" via l'API locale si `cortex-server` tourne, sinon déposé
    dans l'inbox avec un marqueur `todo` (récupéré au prochain démarrage de
    Docteur).
  - `"ouvre Docteur"` → ouvre `docteur_url` dans le navigateur par défaut.
- **Lancement au démarrage de Windows** : désactivé par défaut, à activer
  volontairement via le menu (utilise le registre `Run` de Windows via le
  plugin `tauri-plugin-autostart` — rien d'automatique).

## Confidentialité

- Le micro n'est capturé que pendant l'écoute active (entre les deux appuis
  du raccourci) ; le fichier WAV temporaire et le fichier texte intermédiaire
  produit par whisper-cli sont supprimés **immédiatement** après la
  transcription, qu'elle réussisse ou échoue (`transcribe.rs`).
- Aucun contenu dicté (audio ou texte) n'est écrit dans un fichier de log —
  les seuls messages d'erreur possibles décrivent un problème technique
  (micro absent, whisper-cli introuvable), jamais le contenu de la dictée.
- Aucune connexion réseau sortante nulle part dans ce projet, à une seule
  exception : l'appel local à `cortex-server` pour les "à faire", et
  celui-ci est **vérifié en code** (`api.rs::is_local_only`) pour n'accepter
  que `localhost` / `127.0.0.1` / `::1`, quoi que contienne `config.json`.
- Le dépôt dans l'inbox est une écriture de fichier one-way, aucun endpoint
  réseau — c'est le mécanisme déjà en place et audité dans Docteur.

## Limites connues / non couvert par ce lot

- Pas de fenêtre de configuration graphique — `config.json` s'édite à la
  main (choix délibéré pour la légèreté).
- Le "mot d'activation" (wake word façon "Ok Docteur") n'a pas été implémenté
  — un raccourci clavier global a été choisi à la place : plus fiable
  (aucun faux positif), sans modèle de wake-word supplémentaire à embarquer,
  et explicitement proposé comme alternative dans la demande d'origine.
- Ce code n'a **pas pu être compilé ni testé** dans l'environnement où il a
  été écrit (pas de toolchain Rust disponible). Il suit d'aussi près que
  possible les API documentées de Tauri v2 et de ses plugins officiels
  (`global-shortcut`, `notification`, `opener`, `autostart`), mais un premier
  `cargo tauri dev` peut révéler de petits ajustements de signature à faire
  si une version de plugin a changé son API depuis la rédaction de ce code.
