1. **Cause racine trouvée**

   Le job `83dddf96-8682-43d8-b2c0-07942cb19c41`, lu sans écriture dans SQLite,
   concerne YouTube `B-tTquMDXRQ`. Avec yt-dlp 2026.07.04, les métadonnées sont
   accessibles (9636 secondes), mais le client Android VR obtient un HTTP 403
   lors du téléchargement du format 251. Le format 140 échoue aussi. La conversion
   ffmpeg n'est pas encore atteinte. Avec la version officielle 2026.08.19, les
   clients mis à jour (visionOS observé dans les logs) permettent le téléchargement
   complet du même format 251 puis sa conversion WAV, sans cookies.
   Cela confirme une incompatibilité de l'ancienne extraction YouTube dans cet
   environnement, sans permettre de connaître la règle interne exacte du CDN.

   Le polling a une cause distincte : `App.tsx:4826` crée un `onDone` inline.
   Le modal appelait cette fonction pour chaque réponse terminale ; le rechargement
   du parent changeait sa référence, relançait l'effet dépendant de `onDone`, puis
   un nouveau GET terminal rappelait `onDone`. `setInterval` autorisait aussi les
   requêtes simultanées si une réponse prenait plus longtemps que l'intervalle.

   Source officielle : [release 2026.08.19 et changements YouTube](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19).

2. **Commande yt-dlp qui échouait**

   Le binaire résolu était celui du PATH (aucun `cortex-server/bin` initialement).
   Le code utilisait `spawn` avec les arguments suivants, sans shell :

   ```text
   yt-dlp.exe https://www.youtube.com/watch?v=B-tTquMDXRQ -x --audio-format wav --audio-quality 0 --no-playlist --newline --no-warnings -o C:\dev\Docteur\cortex-server\data\video-jobs\83dddf96-8682-43d8-b2c0-07942cb19c41\full.%(ext)s
   ```

   Aucun `-f` explicite : yt-dlp sélectionnait le format 251, puis devait extraire
   en WAV. La reproduction manuelle utilise un répertoire temporaire distinct du
   job original. Code de sortie reproduit : 1 ; message :
   `ERROR: unable to download video data: HTTP Error 403: Forbidden`.

3. **Fichiers modifiés**

   Code : `cortex-server/src/lib/whisper.js`,
   `cortex-server/src/lib/video-audio-download.js` (nouveau),
   `cortex-server/src/lib/video-pipeline/pipeline.js`,
   `src/components/modals/VideoSummaryModal.tsx`,
   `src/lib/video-job-polling.ts` (nouveau).

   Configuration : les deux `package.json`, `.gitignore`,
   `cortex-server/.env.example` (déjà ignoré par Git).

   Tests nouveaux : `cortex-server/test-video-audio.mjs`,
   `cortex-server/test-video-pipeline.mjs`, `cortex-server/test-video-manual.mjs`,
   `scripts/test-video-polling.mjs`, `scripts/test-video-browser.mjs`,
   `scripts/video-browser-harness.jsx`.

   Installation/documentation : `cortex-server/bin/yt-dlp.exe` (binaire ignoré),
   `cortex-server/bin/SHA2-256SUMS`, `cortex-server/bin/README.md`, ce rapport.
   Les modifications préexistantes dans server.js, teacher, lancedb et les autres
   composants n'ont pas été retouchées.

4. **Changements effectués**

   Installation locale de yt-dlp 2026.08.19 depuis la release officielle ; SHA256
   vérifié : `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a`.
   Le mécanisme existant de détection préfère déjà ce dossier au PATH.
   Extraction audio déléguée à un module backend testable, diagnostics nettoyés,
   délai de 20 minutes par tentative, socket de 30 secondes et retries internes
   de téléchargement/fragment à zéro. Durée metadata bornée à 60 secondes.
   Annulation propagée au processus, y compris ses enfants ffmpeg sous Windows.
   L'API conserve `error`, `done`, `cancelled`, et stocke un message utilisateur
   sans stderr brut. L'étape affichée devient `Erreur` après échec.

5. **Stratégies/fallbacks ajoutés**

   Normal → uniquement sur 403, nouvelle extraction avec
   `-f bestaudio[ext=m4a]/bestaudio/best` et abandon des téléchargements partiels
   → uniquement sur un nouveau 403 et si configuré, même sélection avec
   `--cookies-from-browser chrome` ou `firefox`.
   Configuration : `VIDEO_YTDLP_BROWSER`, vide par défaut. Aucun profil codé en dur.
   Chaque stratégie intervient au maximum une fois par exécution du job ; une
   reprise explicitement demandée par l'utilisateur lance une nouvelle exécution.
   Les erreurs génériques, annulations et timeouts ne déclenchent pas la suite.
   Les headers et clients alternatifs inefficaces ne sont pas ajoutés au runtime.

6. **Commandes exécutées**

   Inspection avec `rg`, `Get-Content`, `git -c safe.directory=C:/dev/Docteur diff`
   et lecture SQLite en mode readonly ; `node --version`, `yt-dlp --version`.
   Reproduction originale avec `spawn`, puis
   `node cortex-server/test-video-manual.mjs` et les modes `--node`, `--compare`,
   `--hls`, `--application`. Téléchargement officiel via `Invoke-WebRequest` et
   contrôle `Get-FileHash -Algorithm SHA256`.

   Validation : `npm.cmd --prefix cortex-server run test:video`,
   `npm.cmd run test:video`, `node scripts/test-video-browser.mjs`,
   `node cortex-server/test-maintenance.mjs`, `npm.cmd run build`,
   `node --check` sur les trois modules backend modifiés, `git diff --check`.
   Démarrage Vite : `npm.cmd run dev -- --host 127.0.0.1 --port 5183 --strictPort`.
   Démarrage backend : `npm.cmd run dev` avec port 3013 et SQLite/LanceDB/logs de
   test sous `data/tmp` ; GET `/api/video-summary/jobs` retourne 200.
   Aucun script lint n'est défini dans les deux packages.

7. **Résultats des tests**

   16 tests backend passent : succès, erreurs génériques, 403 fragmenté entre deux
   buffers, fallback réussi, épuisement avec/sans cookies, Chrome/Firefox,
   absence de secrets dans les diagnostics, timeout, abort avant/pendant spawn,
   binaire absent, configuration invalide, persistance et réponse API terminale,
   annulation du pipeline. SQLite de test est en mémoire.
   9 tests frontend passent : cinq statuts terminaux, intervalle 1500 ms,
   absence de requêtes simultanées, cleanup/réponse tardive, nouveau job,
   erreur réseau transitoire. Un test Chromium/React StrictMode confirme
   l'absence de nouvelle requête après le rechargement du parent et le démontage.
   Aucune erreur JavaScript de page, notamment aucun `require is not defined`.
   Le test de maintenance préexistant passe également.

8. **Résultat du build frontend**

   `tsc && vite build` réussit, génération PWA comprise. Avertissements existants :
   options obsolètes du plugin React et gros chunks. Aucun module Node ajouté au
   code navigateur, aucune dépendance npm supplémentaire.

9. **Résultat du test manuel yt-dlp**

   2026.07.04 : metadata OK ; original 251 → 403 ; audio 140 → 403 ; headers →
   403 ; Safari et essai HLS sans Android VR → aucun format audio disponible.
   L'échantillon de 10 Kio avec Node a pu être téléchargé une fois mais était
   insuffisant pour ffprobe ; le téléchargement complet échouait encore en 403.
   Cette piste n'a donc pas été retenue.

   2026.08.19 : commande originale complète → code 0 en 70,928 s ; essai avec
   option Node → code 0 en 63,500 s. Fonction backend finale `downloadAudio` →
   code 0 en 28,755 s, stratégie normale, stderr vide.
   ffprobe confirme **9635,754667 secondes**, fichier WAV de **1 850 064 974 octets**.
   Aucun cookie utilisé. Les essais réseau ont été autorisés hors du bac à sable
   après le premier échec local WinError 10013.

10. **Comportement final en cas de HTTP 403**

    Deux tentatives maximum sans navigateur, trois avec navigateur configuré.
    Si le refus persiste : job `error`, étape `Erreur`, message « Le site refuse
    le téléchargement de cette vidéo. Une session navigateur ou une
    authentification peut être nécessaire. » Diagnostic technique nettoyé côté
    serveur ; arrêt du polling sur `done`, `completed`, `failed`, `error`,
    `cancelled`. Un seul timeout de polling existe, programmé après chaque réponse.

11. **Risques ou limites restantes**

    Le backend principal s'est rechargé automatiquement : les deux dernières
    détections dans `data/cortex.log` confirment déjà yt-dlp 2026.08.19.
    Le job peut être repris depuis l'historique. Ce job de production n'a pas
    été relancé automatiquement. Téléchargement et conversion validés sur la vidéo
    entière ; transcription et synthèse des 2 h 40 non exécutées intégralement.
    Cookies testés avec processus simulés, pas avec une session personnelle.
    Le site peut encore refuser certains contenus, et yt-dlp devra rester à jour.
    Le fallback de format seul ne corrige pas l'ancienne version sur cette vidéo :
    la mise à jour est la correction effective observée.
    Le binaire ignoré par Git doit être installé sur les autres machines suivant
    `cortex-server/bin/README.md`. Tests d'intégration : Node 22 et mock de modules
    expérimental. Les avertissements Vite antérieurs restent présents.
    Les six répertoires audio de reproduction ont été supprimés après validation,
    et les serveurs temporaires sur les ports 5183 et 3013 ont été arrêtés.

12. **Résumé précis des lignes modifiées**

    `video-audio-download.js:7` : nettoyage des logs ; `:17` : downloader avec
    stratégies bornées ; `:46` : arrêt de l'arbre de processus Windows ; `:96` :
    export conservant l'interface `downloadAudio`.
    `whisper.js:6` : import/réexport du downloader ; `:42` : timeout metadata ;
    suppression de l'ancien bloc de spawn audio, fonctions Whisper/ffmpeg conservées.
    `pipeline.js:42` : abort à l'annulation ; `:191` : AbortController ; `:207` :
    logger/jobId/signal transmis ; `:428` : annulation distincte de l'erreur et
    `current_step` terminal.
    `video-job-polling.ts:1` : statuts terminaux ; `:5` : polling séquentiel et cleanup.
    `VideoSummaryModal.tsx:81` : callback stable via ref ; `:94` : ignore l'historique
    après démontage ; `:108` : nouvel effet de polling ; `:167` : reprise explicite
    d'un même job ; `:354` : état terminal de l'affichage.
    Les deux `package.json:7` exposent `test:video` ; `.gitignore` exclut le binaire ;
    `.env.example:16` documente la configuration des cookies.
