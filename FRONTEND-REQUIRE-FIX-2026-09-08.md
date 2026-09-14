1. **Cause racine du `require is not defined`**

   `tesseract.js` 5.1.1 était dans `optimizeDeps.exclude`. Vite servait donc son
   point d'entrée CommonJS directement au navigateur, sans conversion en ESM.
   Reproduction dans Chromium avant correction :

   ```text
   ReferenceError: require is not defined
   at http://127.0.0.1:5183/node_modules/tesseract.js/src/index.js?v=bff43d20:10:1
   ```

   Le hash Vite diffère selon le cache ; le fichier et la ligne correspondent
   exactement au `index.js?v=0a4e79b4:10` signalé. Aucun bundle généré ou fichier
   dans node_modules n'a été modifié.

2. **Fichier source responsable**

   Source de l'appel : `node_modules/tesseract.js/src/index.js`.
   Configuration fautive : `vite.config.ts`, bloc `optimizeDeps`.
   Déclencheur : `src/hooks/useScreenOcr.ts`, appelé par `ScreenCaptureModal`.
   Le chemin d'import est : modal de capture → hook OCR → import dynamique
   `tesseract.js` → champ `main: src/index.js` du package.

3. **Ligne ou fonction responsable**

   Ligne 10 de Tesseract : `require('regenerator-runtime/runtime');`.
   L'import dynamique du hook était avant le `try/catch` : son rejet s'échappait
   et le `finally` ne libérait jamais `busyRef`. L'événement React lançait ensuite
   une promesse rejetée sans gestion locale dans `handleExtractText`.

4. **Pourquoi CommonJS arrivait dans le navigateur**

   L'exclusion Vite reposait sur l'idée que toute bibliothèque utilisant des
   workers/WASM devait éviter le prébundling. Cela ne convient pas au point
   d'entrée CommonJS de Tesseract. Ses assets worker/WASM peuvent rester locaux
   tout en faisant convertir son API en ESM. Tesseract fournit un adaptateur
   navigateur via le champ `browser` de son package ; il n'est pas Node-only.
   Référence : [documentation Vite sur les dépendances CommonJS](https://vite.dev/config/dep-optimization-options).

5. **Fichiers modifiés pendant cette intervention**

   - `vite.config.ts` : Tesseract ajouté à `include`, retiré de `exclude`.
   - `src/hooks/useScreenOcr.ts` : import dans le try/catch et type Worker officiel.
   - `src/components/modals/ScreenCaptureModal.tsx` : gestion des échecs de préparation d'image.
   - `src/lib/video-job-polling.ts` : attente et gestion des rejets de `onTerminal`.
   - `scripts/test-video-polling.mjs` : test du callback terminal asynchrone rejeté.
   - `scripts/frontend-browser-harness.jsx` et `scripts/test-frontend-browser.mjs` : tests Chromium.
   - `package.json` : commande `test:browser`.
   - Ce rapport.

   Aucun fichier backend, package tiers ou asset généré n'a été retouché.
   Aucune dépendance npm ajoutée.

6. **Code avant/après pour la correction principale**

   Avant, dans `vite.config.ts` :

   ```ts
   optimizeDeps: {
     exclude: ['@picovoice/porcupine-web', '@picovoice/web-voice-processor',
       '@mediapipe/tasks-vision', 'tesseract.js'],
   }
   ```

   Après :

   ```ts
   optimizeDeps: {
     include: ['tesseract.js'],
     exclude: ['@picovoice/porcupine-web', '@picovoice/web-voice-processor',
       '@mediapipe/tasks-vision'],
   }
   ```

   Le hook conserve `await import('tesseract.js')` pour le chargement à la demande,
   désormais **dans** son `try/catch/finally`. Le type `Worker` importé avec
   `import type` n'ajoute aucun chargement JavaScript au démarrage.

7. **Résultat de la recherche des autres require**

   Recherche de `require(`, `module.exports`, `exports.`, `__dirname`, `__filename`
   dans `src` : aucun résultat. Aucun import Node ou backend dans les utilitaires
   vidéo, le client HTTP, le modal ou le polling.

   Classification des occurrences tierces :

   | Emplacement | Traitement |
   | --- | --- |
   | Tesseract `src/index.js:10-17`, `module.exports` et ses modules internes | Conversion CommonJS → ESM par Vite, sans modifier le package. Import dynamique conservé car OCR occasionnel. |
   | React et autres dépendances CommonJS prébundlées | Encapsulation locale par le bundler, aucun `require` global nécessaire. |
   | `public/mediapipe/vision_wasm*_internal.js` : `node:fs`, `node:path`, `node:url`, `node:crypto` | Branches gardées par `ENVIRONMENT_IS_NODE`, inactives dans le navigateur ; assets fournisseurs inchangés. |
   | Exports UMD des assets MediaPipe/Tesseract et workers compilés | Détection d'environnement ou runtime interne de bundle ; pas de déplacement backend nécessaire. |
   | `vite.config.ts` : `fs`, `path` | Configuration exécutée par Node, hors graphe navigateur. |

   Les deux packages Picovoice exposent `dist/esm/index.js` ; MediaPipe expose
   `vision_bundle.mjs` pour les imports navigateur. Ils restent exclus comme avant.
   Aucun helper yt-dlp/cookies n'entre dans le graphe frontend.

8. **Résultat des tests**

   - `npm.cmd run test:video` : **10/10**, dont les cinq états terminaux et le rejet asynchrone de callback.
   - `npm.cmd --prefix cortex-server run test:video` : **16/16**, fallback 403 et cookies inclus.
   - `npm.cmd run test:browser` : **4 scénarios réussis** : OCR réel, import refusé avec retry possible, image invalide, parcours vidéo HTTP.
   - `git diff --check` : aucune erreur de whitespace.
   - Aucun script lint n'est défini dans les packages. Typecheck réalisé par `tsc` dans le build.

   Pour relancer les tests navigateur, démarrer Vite sur le port 5183 :
   `npm.cmd run dev -- --host 127.0.0.1 --port 5183 --strictPort`, puis
   `npm.cmd run test:browser`. `FRONTEND_TEST_URL` permet d'utiliser une autre origine.

9. **Résultat du build**

   `npm.cmd run build` (`tsc && vite build`) réussit, génération PWA comprise.
   La suppression du `any` a révélé un ancien type approximatif de `terminate()` ;
   corrigé en utilisant le type Worker officiel avant de revalider.
   Les avertissements existants du plugin React et des gros chunks restent présents.

10. **Résultat du test navigateur**

    Chromium charge le module optimisé `/node_modules/.vite/deps/tesseract__js.js`
    et reconnaît `HELLO CORTEX 123` avec les vrais worker, WASM et données fra/eng.
    Tous les assets OCR restent locaux. Aucun module OCR chargé avant l'action.
    Une panne d'import simulée s'affiche dans l'UI, permet un nouvel essai et ne
    produit aucune promesse non gérée. Même résultat pour une image invalide.

    Parcours vidéo avec vraies requêtes du client HTTP et réponses simulées :
    estimation, POST de création 201, premier GET actif, second GET en erreur,
    affichage du message et aucun GET supplémentaire pendant 3,3 secondes.
    Aucun job réel de production n'est créé par ce test.

    L'application complète a aussi été ouverte depuis `/` : clic sur le bouton
    de la barre supérieure, modal vidéo affiché, aucune erreur JavaScript.
    Pour cet essai sur le port alternatif, les GET backend ont été relayés par
    Playwright et les écritures bloquées pour préserver les données.
    `typeof window.require` reste `undefined` dans les tests : aucun faux polyfill.

11. **Confirmation du polling**

    Un seul timeout, délai 1500 ms après chaque réponse, aucune requête simultanée
    pour un même poller. Cleanup au démontage/changement de job, réponse tardive
    ignorée, arrêt sur done/completed/failed/error/cancelled. Le callback terminal
    est maintenant attendu dans le try/catch ; son rejet ne redémarre pas le polling.

12. **Confirmation du fix 403 backend**

    Aucun code backend modifié pendant cette correction. yt-dlp, ffmpeg, cookies,
    filesystem et child_process restent côté serveur. Les 16 tests backend passent.
    La validation réelle du téléchargement faite lors de la précédente intervention
    n'a pas été répétée, car cette correction ne change pas ce chemin d'exécution.

13. **Risques ou limites restantes**

    Les parcours navigateur sont testés dans Chromium ; pas de validation Firefox
    ou Safari durant cette intervention. La création vidéo du test est simulée
    au niveau HTTP. Les autres fonctions matérielles (caméra/micro) n'ont pas été
    exercées. Aucun secret ni contenu OCR utilisateur n'a été utilisé ou journalisé.
    Vite invalide le cache de dépendances après modification de sa configuration ;
    une page déjà ouverte doit être rechargée pour utiliser les nouveaux modules.
    Le serveur temporaire 5183 a été arrêté. Le serveur déjà présent sur 5173
    répond HTTP 200 et sert bien le hook corrigé avec Tesseract optimisé, vérifié
    sur localhost et 127.0.0.1. Aucun processus utilisateur n'a été arrêté.
