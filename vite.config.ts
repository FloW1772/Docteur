import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { defineConfig, type ViteDevServer, type PreviewServer } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
// [GAME-4] bundles the Synapse Run game + local three into /arcade/synapse-run/game.js (classic script, no CDN)
import { arcadeGameBundlePlugin } from './scripts/vite-arcade-game-bundle.mjs';

// LOCAL_NETWORK=true → Vite binds to 0.0.0.0 so mobile devices can connect.
const localNetwork = process.env.LOCAL_NETWORK === 'true';

// HTTPS cert for the production preview server (mobile mode only).
// The dev server (npm run dev) stays on HTTP so the browser's IndexedDB
// origin (http://localhost:5173) matches and existing neurons are visible.
// Run `node scripts/gen-cert.mjs` to regenerate if the cert is missing.
const certsDir = resolve('./certs');
const httpsOptions = localNetwork && existsSync(`${certsDir}/key.pem`) && existsSync(`${certsDir}/cert.pem`)
  ? { key: readFileSync(`${certsDir}/key.pem`), cert: readFileSync(`${certsDir}/cert.pem`) }
  : undefined;
if (localNetwork && !httpsOptions) {
  throw new Error('LOCAL_NETWORK=true requires TLS certificates in certs/key.pem and certs/cert.pem; refusing cleartext LAN startup');
}

// Binding a single Node socket to '127.0.0.1' only accepts IPv4 — on this
// machine (and many Windows setups) the browser resolves "localhost" to the
// IPv6 loopback (::1) first, which no one is listening on, hence
// ERR_CONNECTION_REFUSED. Binding to '::' instead makes Node listen dual-stack
// (both ::1 and 127.0.0.1 accept connections), but '::' also accepts LAN
// traffic on Windows — unacceptable for normal dev mode. This plugin closes
// any connection whose remote address isn't a loopback address, so the dual
// stack bind behaves as loopback-only in practice. Only applied outside
// LOCAL_NETWORK mode, which deliberately keeps its existing LAN-exposing
// host:true behavior for mobile testing.
function loopbackOnlyPlugin() {
  const protect = (server: ViteDevServer | PreviewServer) => {
    server.httpServer?.on('connection', (socket) => {
      const addr = socket.remoteAddress;
      const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
      if (!isLoopback) socket.destroy();
    });
  };
  return {
    name: 'loopback-only',
    configureServer: protect,
    configurePreviewServer: protect,
  };
}

// [SEC-REMED-1 / SEC-2] The Vite DEV server serves the whole project tree (user DB, backups, logs, reports, source),
// so it must never face the LAN: LOCAL_NETWORK=true is accepted only by `vite preview`, which serves dist/ alone.
export const LAN_DEV_SERVER_DISABLED = 'LAN_DEV_SERVER_DISABLED';

export default defineConfig(({ command, isPreview }) => {
  if (localNetwork && command === 'serve' && !isPreview) {
    throw new Error(`${LAN_DEV_SERVER_DISABLED}: LOCAL_NETWORK=true is refused for the Vite dev server (it would expose the project tree on the LAN). Use \`npm run build\` + \`vite preview\` (dist/ only).`);
  }
  return {
  plugins: [
    react(),
    ...(localNetwork ? [] : [loopbackOnlyPlugin()]),
    arcadeGameBundlePlugin(),
    VitePWA({
      // 'prompt' (not 'autoUpdate'): an update must never force a silent
      // window.location.reload() while the user has an operation in flight
      // (typing, a generation running, unsaved edits). main.tsx wires
      // onNeedRefresh to show a dismissible banner instead — the user (or
      // UpdateBanner, after flushing pending saves) decides when to reload.
      registerType: 'prompt',
      // Disable the SW entirely in dev mode — it must never intercept Vite's
      // HMR/client requests (@vite/client, @react-refresh, etc.).
      devOptions: { enabled: false },
      // Manually registered in main.tsx via virtual:pwa-register so we can
      // attach onRegistered / onRegisterError callbacks.
      injectRegister: null,

      includeAssets: ['icon-192.svg', 'icon-512.svg'],

      manifest: {
        name: 'Docteur — Cortex Personnel',
        short_name: 'Docteur',
        description: 'Ton second cerveau personnel',
        start_url: '/',
        display: 'standalone',
        background_color: '#0a0814',
        theme_color: '#0a0814',
        orientation: 'portrait-primary',
        lang: 'fr',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },

      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,ico,png,woff,woff2}'],
        // Porcupine WASM (~3.35 MB) is packaged as esm-*.js by Vite.
        // MediaPipe WASM + model (~12 MB) are served from /mediapipe/ on demand.
        // Tesseract.js worker + WASM core + fra/eng traineddata (~7.5 MB) are
        // served from /tesseract/ on demand, loaded only on first OCR use.
        // None of these should bloat the SW precache.
        globIgnores: ['**/esm-*.js', 'mediapipe/**', 'tesseract/**'],

        // SPA: any navigation that is not an API call falls back to index.html.
        // [GAME-2] Arcade game pages (public/arcade/**) are real static documents with their own CSP: they are
        // served (precached) as themselves and must never be rewritten to the Docteur app shell.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/arcade\//],

        runtimeCaching: [
          // NB-3: Google Fonts runtime caching removed — fonts are no longer fetched from a third party.
          // ── cortex-server API (port 3001) — NEVER cache ───────────────────
          // Covers both HTTP (localhost dev) and HTTPS (LAN mobile).
          {
            urlPattern: ({ url }) => url.port === '3001',
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],

  optimizeDeps: {
    // Without an explicit entry, Vite's dependency scanner crawls the whole
    // project tree for HTML (its default glob is not gitignore-aware) and
    // picks up the gitignored external/MetaGPT and external/OpenMontage
    // nested repos sitting under the repo root. One of their HTML files
    // fails to parse, aborting the scan mid-flight and leaving a stale
    // node_modules/.vite/deps_temp_* behind (hence the EPERM rename and the
    // 504 Outdated Optimize Dep on every subsequent request). Pinning the
    // scan to Docteur's real entry avoids both nested repos entirely.
    entries: ['index.html'],
    // Tesseract's CommonJS entry needs conversion to ESM, even when lazy-loaded.
    // Its worker/WASM assets remain served separately from public/tesseract/.
    include: ['tesseract.js'],
    // These libraries already provide ESM browser entries.
    exclude: [
      '@picovoice/porcupine-web',
      '@picovoice/web-voice-processor',
      '@mediapipe/tasks-vision',
    ],
  },

  server: {
    port: 5173,
    // If 5173 is already taken (e.g. a leftover Vite process), fail loudly
    // instead of silently moving to 5174/5175 — a silent port change breaks
    // cortex-server's CORS allowlist (locked to 5173) with no visible error.
    strictPort: true,
    // Dual-stack bind so both http://localhost:5173 (-> ::1 on this machine)
    // and http://127.0.0.1:5173 work. Outside LOCAL_NETWORK mode the
    // loopback-only plugin above rejects any non-loopback connection, so
    // this does not expose the server to the LAN.
    host: localNetwork ? true : '::',
    watch: {
      // external/MetaGPT and external/OpenMontage are gitignored nested
      // repos (each with their own .git, and MetaGPT its own Python .venv)
      // that live under the repo root but are never part of the Docteur
      // frontend. Vite's default watch ignores already cover node_modules
      // and .git, but not this project-specific nested-repo layout, so
      // without this they'd add pure watcher churn for zero benefit.
      ignored: ['**/external/**'],
    },
    // Normal dev keeps its HTTP origin; explicit LAN mode matches backend TLS.
    https: httpsOptions,
  },

  // Preview uses the same explicit LAN opt-in and loopback guard as dev.
  preview: {
    port: 5173,
    strictPort: true,
    host: localNetwork ? true : '::',
    https: httpsOptions,
  },
  };
});
