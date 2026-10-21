import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Gamepad2 } from 'lucide-react';
import '../src/styles/globals.css';
import StudioShell from '../src/components/studio/StudioShell';
import { createArcadeSaveStore, createIdbSaveBackend } from '../src/lib/arcade/saves.ts';

// [GAME-3] Arcade save harness: the same StudioShell + lazy ArcadePanel mount as App.tsx, nothing else (no
// Dashboard, no API). The page plants synthetic "private Docteur data" the sandboxed game must not reach, and
// exposes a latency probe that drives the real store + IndexedDB adapter on synthetic data only.
const ArcadePanel = lazy(() => import('../src/components/arcade/ArcadePanel'));

function Harness() {
  return (
    <div>
      <p data-testid="parent-secret">PARENT-DOM-SECRET-3c9e</p>
      <StudioShell icon={<Gamepad2 size={18} />} title="Arcade" onClose={() => {}} subtitle="Jeux locaux isolés · sans réseau ni données Docteur">
        <Suspense fallback={<p>Chargement…</p>}><ArcadePanel /></Suspense>
      </StudioShell>
    </div>
  );
}

async function timed(run) {
  const start = performance.now();
  const result = await run();
  return { ms: performance.now() - start, ok: result.ok };
}

async function bench(rounds) {
  const samples = { open: [], smallWrite: [], boundWrite: [], load: [], remove: [] };
  const small = { synthetic: true, n: 1 };
  const bound = 'b'.repeat(65_534); // exactly 65 536 bytes as JSON
  for (let i = 0; i < rounds; i++) {
    const store = createArcadeSaveStore({ backend: createIdbSaveBackend() }); // fresh connection each round
    samples.open.push(await timed(() => store.load('synapse-run')));
    samples.smallWrite.push(await timed(() => store.write('synapse-run', 1, small)));
    samples.boundWrite.push(await timed(() => store.write('synapse-run', 1, bound)));
    samples.load.push(await timed(() => store.load('synapse-run')));
    samples.remove.push(await timed(() => store.remove('synapse-run')));
  }
  const summary = {};
  for (const [name, list] of Object.entries(samples)) {
    const ms = list.map(s => s.ms).sort((a, b) => a - b);
    summary[name] = { rounds, allOk: list.every(s => s.ok), medianMs: Number(ms[Math.floor(ms.length / 2)].toFixed(2)), maxMs: Number(ms[ms.length - 1].toFixed(2)) };
  }
  return summary;
}

export function mount() {
  window.__arcadeSyntheticState = { secret: 'PARENT-STATE-SECRET-8b1d' };
  window.__arcadeSaveBench = bench;
  localStorage.setItem('docteur.arcade-test-secret', 'PARENT-LS-SECRET-27fa');
  sessionStorage.setItem('docteur.arcade-test-secret', 'PARENT-SS-SECRET-61d0');
  document.cookie = 'docteur_arcade_test=PARENT-COOKIE-SECRET; path=/';
  createRoot(document.getElementById('root')).render(<Harness />);
}
