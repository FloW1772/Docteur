// [GAME-4] Docteur Arcade — builds the Synapse Run game script (src/arcade/synapse-run/main.ts + the locally
// installed, lock-pinned `three` package) into ONE classic IIFE script served at /arcade/synapse-run/game.js.
//
// Why a classic script: the game page runs in <iframe sandbox="allow-scripts"> (opaque origin). Module scripts are
// fetched in CORS mode, which an opaque origin cannot satisfy without loosening the server; a classic same-site
// script needs nothing and matches the page CSP (script-src 'self'). No CDN, no network, nothing generated is
// committed: dev serves the bundle from memory, `vite build` emits it into dist/ (precached like the page).
//
// The bundle carries a banner naming the bundled third-party code (three, MIT licence).
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';

export const ARCADE_GAME_ENTRY = 'src/arcade/synapse-run/main.ts';
export const ARCADE_GAME_PATH = 'arcade/synapse-run/game.js';
const SOURCE_DIR = 'src/arcade/synapse-run';

/** @param {{ root: string, testHooks: boolean }} options */
export async function bundleArcadeGame({ root, testHooks }) {
  const three = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/three/package.json'), 'utf8'));
  const banner = `/*! Synapse Run — Docteur Arcade (original game code). Bundles three@${three.version} (${three.license} licence, Copyright 2010-2024 Three.js Authors). */`;
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    publicDir: false,
    plugins: [],
    define: { __SYNAPSE_TEST_HOOKS__: JSON.stringify(testHooks === true) },
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      sourcemap: false,
      minify: true,
      target: 'es2020',
      lib: { entry: path.join(root, ARCADE_GAME_ENTRY), formats: ['iife'], name: 'SynapseRun', fileName: () => 'game.js' },
      rolldownOptions: { output: { banner } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output ?? []);
  const chunk = outputs.find(item => item.type === 'chunk');
  if (!chunk) throw new Error('ARCADE_GAME_BUNDLE_EMPTY');
  return chunk.code.startsWith('/*!') ? chunk.code : `${banner}\n${chunk.code}`;
}

function latestSourceMtime(root) {
  let latest = 0;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else latest = Math.max(latest, fs.statSync(full).mtimeMs);
    }
  };
  walk(path.join(root, SOURCE_DIR));
  return latest;
}

/**
 * Vite plugin. `testHooks: true` (test harnesses only) compiles in the deterministic __synapseRunTest API;
 * the product config never sets it, so production bundles do not contain it.
 * @param {{ testHooks?: boolean }} [options]
 */
export function arcadeGameBundlePlugin({ testHooks = false } = {}) {
  let root = process.cwd();
  let cache = null;
  return {
    name: 'docteur-arcade-game-bundle',
    configResolved(config) { root = config.root; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if ((req.url ?? '').split(/[?#]/)[0] !== `/${ARCADE_GAME_PATH}`) return next();
        try {
          const mtime = latestSourceMtime(root);
          if (!cache || cache.mtime !== mtime) cache = { mtime, code: bundleArcadeGame({ root, testHooks }) };
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
      this.emitFile({ type: 'asset', fileName: ARCADE_GAME_PATH, source: await bundleArcadeGame({ root, testHooks }) });
    },
  };
}
