import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// LOCAL_NETWORK=true → Vite binds to 0.0.0.0 so mobile devices can connect.
const localNetwork = process.env.LOCAL_NETWORK === 'true';

// HTTPS cert for the production preview server (mobile mode only).
// The dev server (npm run dev) stays on HTTP so the browser's IndexedDB
// origin (http://localhost:5173) matches and existing neurons are visible.
// Run `node scripts/gen-cert.mjs` to regenerate if the cert is missing.
const certsDir = resolve('./certs');
const httpsOptions = existsSync(`${certsDir}/key.pem`)
  ? { key: readFileSync(`${certsDir}/key.pem`), cert: readFileSync(`${certsDir}/cert.pem`) }
  : undefined;

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
  return {
    name: 'loopback-only',
    configureServer(server) {
      server.httpServer?.on('connection', (socket) => {
        const addr = socket.remoteAddress;
        const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
        if (!isLoopback) socket.destroy();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    ...(localNetwork ? [] : [loopbackOnlyPlugin()]),
    VitePWA({
      registerType: 'autoUpdate',
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
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],

        runtimeCaching: [
          // ── Google Fonts — cache on first load, serve offline ─────────────
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-assets',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
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
    // No HTTPS here — dev stays on http://localhost:5173 to preserve IDB origin.
  },

  // Production preview: always bind to 0.0.0.0 for LAN access.
  preview: {
    port: 5173,
    host: true,
    https: httpsOptions,
  },
});
