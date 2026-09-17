# PHASE 3 — Audit et amélioration PWA

Mode : audit d'abord, fix minimal ciblé ensuite (validé par l'utilisateur). Aucune réécriture de la PWA, aucune nouvelle dépendance.

## Audit

### Manifest — PASS
`vite.config.ts` (VitePWA `manifest`) : `name`, `short_name`, `description`, `start_url`, `display: standalone`, `theme_color`/`background_color` cohérents (`#0a0814`), `orientation`, `lang: fr`, `categories`. Icônes : `icon-192.svg` (`purpose: any`) et `icon-512.svg` (`purpose: any maskable`). Manifest généré vérifié via `curl` sur le build de preview — JSON valide, `scope: "/"` ajouté automatiquement. `index.html` : meta `theme-color`, `apple-mobile-web-app-*`, `apple-touch-icon`, favicon — tous corrects, cohérents avec le manifest.

### Service Worker — PASS
Enregistré uniquement en production (`import.meta.env.PROD`), désenregistré/caches vidés systématiquement en dev pour ne jamais intercepter le HMR Vite. `sw.js` généré vérifié directement (bytes du build) : `precacheAndRoute` limité à 16 entrées d'assets statiques (JS/CSS/icônes/manifest/index.html), rien de dynamique.

### Cache privé — 0 (confirmé)
`runtimeCaching` : Google Fonts en `CacheFirst` (statique, non sensible) ; règle dédiée `({url}) => url.port === '3001'` → **`NetworkOnly`**, qui couvre toutes les requêtes vers cortex-server (HTTP dev et HTTPS LAN mobile). `navigateFallbackDenylist: [/^\/api\//]` exclut aussi l'API du fallback SPA. Vérifié au niveau du `sw.js` compilé (pas seulement la config source) : la règle `NetworkOnly` et le port `3001` sont bien présents dans le bytecode généré. **Aucun token, callback OAuth, credential ou réponse privée ne peut entrer dans le cache Workbox — structurellement impossible avec cette règle.**

### Installabilité — PASS
Manifest reconnu, Service Worker enregistré, icônes présentes (192/512, maskable sur la 512). Aucun bouton d'installation custom inventé — le navigateur gère l'invite native.

### Update flow — **PARTIEL → corrigé**
**Problème trouvé** : `registerType: 'autoUpdate'` + aucun `onNeedRefresh`/`onNeedReload` câblé dans `main.tsx`. Lecture du template runtime compilé de `vite-plugin-pwa` (`node_modules/vite-plugin-pwa/dist/client/build/register.js:39-47`) : en mode `autoUpdate` sans callback fourni, une mise à jour de SW déclenche **`window.location.reload()` immédiat et silencieux**, dès que le nouveau Service Worker est activé — sans confirmation, potentiellement en pleine saisie/génération/synchronisation. Violation directe de la règle "ne pas forcer un reload au milieu d'une opération en cours".

**Fix appliqué** (validé par l'utilisateur avant écriture) :
- `vite.config.ts` : `registerType: 'autoUpdate'` → `'prompt'`. Conséquence vérifiée dans le `sw.js` généré : `clientsClaim` n'est plus injecté (`skipWaiting` reste, mais ne prend plus effet sur les onglets ouverts sans confirmation explicite).
- `src/main.tsx` : câblage de `onNeedRefresh` (dispatch d'un `CustomEvent('docteur-sw-update-available')`, suivant le pattern déjà utilisé ailleurs dans le code — `docteur-sidebar-gesture`) et `onOfflineReady` (log informatif). Expose `window.docteurApplySWUpdate()`, qui déclenche le reload réel une fois l'utilisateur confirmé.
- Nouveau composant `src/components/layout/UpdateBanner.tsx` : bandeau discret ("Une nouvelle version de Docteur est disponible", boutons **Mettre à jour** / **Plus tard**), thème repris de `.toast` existant (mêmes couleurs/police/blur), rendu dans `App.tsx` aux côtés du `Toast` existant. **Mettre à jour** appelle d'abord `flushAllSaves()` (hook déjà existant dans `usePages()`, déjà utilisé sur `beforeunload`) puis déclenche le reload — jamais l'inverse.
- CSS ajoutée dans `globals.css`, réutilise les tokens visuels existants (`rgba(12,9,22,0.94)`, accent `#3dffaa`, `IBM Plex Mono`), aucune nouvelle palette.

Build vérifié après fix : `dist/sw.js` régénéré, `clientsClaim` absent, `skipWaiting` toujours présent (comportement attendu du mode `prompt`), précache 16 entrées (+1,9 KiB pour le nouveau composant). Typecheck : OK.

### Offline / reconnect — PASS
`ServerStartup.tsx` (préexistant, non modifié) : écran d'attente avec backoff exponentiel (800ms → plafond 5s), affichage du temps écoulé, et après 15s un bouton explicite "Ouvrir la copie hors ligne" — jamais une app qui prétend fonctionner alors que le backend local est injoignable. Déjà conforme à la règle 3.6 sans modification nécessaire.

### Cold start / reload — PASS (structurel)
Pas de régression introduite : le changement ne touche que le déclenchement du reload en cas de *mise à jour* de SW, pas le chargement initial. `ServerStartup` gère déjà le cold start (attente backend) indépendamment du SW.

### Console — PASS
Aucune nouvelle erreur introduite. `onOfflineReady`/`onRegistered`/`onRegisterError` restent des `console.log`/`console.error` informatifs déjà existants dans le style du fichier.

---

## Vérification

- **Typecheck** : `npx tsc --noEmit` — OK, aucune erreur (frontend).
- **Build** : `npm run build` — OK, 1.27s, précache 16 entrées (1771.84 KiB, +1,9 KiB vs baseline Phase 0).
- **Preview réel** : serveur de preview lancé, `index.html` (200), `sw.js` (bytecode valide, règles confirmées), `manifest.webmanifest` (JSON valide) tous vérifiés par requête HTTP directe, puis serveur arrêté proprement.
- **Fichiers modifiés** : `vite.config.ts`, `src/main.tsx`, `src/App.tsx`, `src/styles/globals.css`.
- **Fichier créé** : `src/components/layout/UpdateBanner.tsx`.
- **Aucun fichier backend touché** — Phase 3 est strictement frontend, donc aucun impact possible sur la suite de tests backend (non relancée, sans rapport avec ce changement).
- **Aucune nouvelle dépendance** installée (`package.json`/`package-lock.json` inchangés, vérifié par `git status`).
- **Aucun `shell:true` nouveau** (aucun code serveur touché).
- **DB réelle / donnée utilisateur** : non concernées, aucun code backend ni aucune donnée persistée n'a été touché par cette phase.
- **Appel cloud live** : 0 (aucun test réseau réel, uniquement un serveur de preview local arrêté après vérification).

---

## GATE PHASE 3

```
PWA QUALITY : PASS

Manifest : PASS
SW : PASS
Cache privé : 0 (confirmé au niveau du sw.js compilé)
Update flow : PASS (corrigé — registerType: prompt + UpdateBanner, flush avant reload)
Offline/reconnect : PASS (déjà conforme, ServerStartup.tsx non modifié)
Build : PASS
```
