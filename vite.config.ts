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

export default defineConfig({
  plugins: [
    react(),
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
        // Wake-word detection only works when the cortex-server is running,
        // so precaching it for offline use serves no purpose and wastes 3+ MB
        // on first mobile SW registration.
        globIgnores: ['**/esm-*.js'],

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
    // Porcupine uses Web Workers + WASM — Vite must not pre-bundle them
    exclude: ['@picovoice/porcupine-web', '@picovoice/web-voice-processor'],
  },

  server: {
    port: 5173,
    host: localNetwork ? true : '127.0.0.1',
    // No HTTPS here — dev stays on http://localhost:5173 to preserve IDB origin.
  },

  // Production preview: always bind to 0.0.0.0 for LAN access.
  preview: {
    port: 5173,
    host: true,
    https: httpsOptions,
  },
});
