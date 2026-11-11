// [FILAMENT-1] Docteur Arcade — builds the Filament game script (src/arcade/filament/main.ts, original code only, no
// third-party package) into ONE classic IIFE script served at /arcade/filament/game.js.
//
// Same approach as scripts/vite-arcade-game-bundle.mjs (Synapse Run), kept as a separate plugin on purpose: the
// Synapse Run bundle and its certified output are not touched by adding a second game. Classic script for the same
// reason (opaque-origin sandbox, page CSP script-src 'self'). No CDN, no network, nothing generated is committed: dev
// serves the bundle from memory, `vite build` emits it into dist/ (precached like the page).
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';

export const FILAMENT_GAME_ENTRY = 'src/arcade/filament/main.ts';
export const FILAMENT_GAME_PATH = 'arcade/filament/game.js';
const SOURCE_DIR = 'src/arcade/filament';
const BANNER = '/*! Filament — Docteur Arcade (original game code, no third-party code). */';

/** @param {{ root: string }} options */
export async function bundleFilamentGame({ root }) {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    publicDir: false,
    plugins: [],
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      sourcemap: false,
      minify: true,
      target: 'es2020',
      lib: { entry: path.join(root, FILAMENT_GAME_ENTRY), formats: ['iife'], name: 'Filament', fileName: () => 'game.js' },
      rolldownOptions: { output: { banner: BANNER } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output ?? []);
  const chunk = outputs.find(item => item.type === 'chunk');
  if (!chunk) throw new Error('FILAMENT_GAME_BUNDLE_EMPTY');
  return chunk.code.startsWith('/*!') ? chunk.code : `${BANNER}\n${chunk.code}`;
}

/** Newest mtime of the (flat) game source folder: the dev bundle is rebuilt only when a source file changed. */
function latestSourceMtime(root) {
  let latest = 0;
  for (const entry of fs.readdirSync(path.join(root, SOURCE_DIR), { withFileTypes: true })) {
    if (entry.isFile()) latest = Math.max(latest, fs.statSync(path.join(root, SOURCE_DIR, entry.name)).mtimeMs);
  }
  return latest;
}

/** Vite plugin: dev = in-memory middleware for exactly /arcade/filament/game.js; build = one emitted asset. */
export function arcadeFilamentBundlePlugin() {
  let root = process.cwd();
  let cache = null;
  return {
    name: 'docteur-arcade-filament-bundle',
    configResolved(config) { root = config.root; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if ((req.url ?? '').split(/[?#]/)[0] !== `/${FILAMENT_GAME_PATH}`) return next();
        try {
          const mtime = latestSourceMtime(root);
          if (!cache || cache.mtime !== mtime) cache = { mtime, code: bundleFilamentGame({ root }) };
          const code = await cache.code;
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(code);
        } catch (error) {
          cache = null;
          next(error);
        }
      });
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: FILAMENT_GAME_PATH, source: await bundleFilamentGame({ root }) });
    },
  };
}
