# yt-dlp local

Le serveur privilégie `cortex-server/bin/yt-dlp.exe`, sinon le binaire du PATH.
Version validée le 8 septembre 2026 : **2026.08.19**. Le binaire local est ignoré
par Git. Redémarrer le backend après installation si le dossier bin était absent.

La version 2026.07.04 sélectionnait le client YouTube Android VR et recevait un
HTTP 403 sur la vidéo de reproduction. La version 2026.08.19 utilise les clients
mis à jour et télécharge puis convertit cette même vidéo sans cookies.

Installation reproductible depuis la racine du dépôt, dans PowerShell :

```powershell
New-Item -ItemType Directory -Path cortex-server/bin -Force | Out-Null
Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe' -OutFile 'cortex-server/bin/yt-dlp.exe'
$downloadHash = (Get-FileHash 'cortex-server/bin/yt-dlp.exe' -Algorithm SHA256).Hash
if ($downloadHash -ne '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a') { throw 'SHA256 incorrect' }
```

Sources : [release officielle](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19),
[SHA256 officiels](https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS).

Option backend dans `cortex-server/.env` : `VIDEO_YTDLP_BROWSER=chrome` ou
`VIDEO_YTDLP_BROWSER=firefox`. Sans cette variable, aucune session navigateur
n'est demandée par le code. Cette option n'est utilisée qu'après deux refus 403.
Les profils restent ceux choisis par yt-dlp ; aucun chemin utilisateur n'est codé.
`LOG_LEVEL=debug` active les diagnostics nettoyés des tentatives réussies.

Tests depuis la racine :

```powershell
npm.cmd --prefix cortex-server run test:video
npm.cmd run test:video
npm.cmd run build
# Avec Vite lancé sur 127.0.0.1:5183 :
node scripts/test-video-browser.mjs
# Réseau requis ; télécharge et convertit la vidéo complète (environ 1,85 Go WAV) :
node cortex-server/test-video-manual.mjs --application
```

Les tests d'intégration backend utilisent le mock de modules expérimental de
Node 22. Les essais manuels déposent leurs fichiers dans `data/tmp/video-repro-*`.
Les autres modes manuels sont réservés au diagnostic : sans option (formats,
headers et client Safari), `--node`, `--compare`, `--hls`. `--test` tronque le
flux à 10 Kio et ne garantit pas une conversion WAV valide.
