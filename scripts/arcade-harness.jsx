import React, { Suspense, lazy, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Gamepad2 } from 'lucide-react';
import '../src/styles/globals.css';
import Dashboard from '../src/components/hud/Dashboard';
import HelpModal from '../src/components/modals/HelpModal';
import StudioShell from '../src/components/studio/StudioShell';

// [GAME-2] Arcade harness: the real Dashboard (opt-in launcher card), the real Help Center and the same
// StudioShell + lazy ArcadePanel mount as App.tsx (`case 'arcade'` → setArcadeOpen(true)). Only the network is
// controlled by the test (page.route). The page also plants "private Docteur data" the sandboxed game must not reach.
const ArcadePanel = lazy(() => import('../src/components/arcade/ArcadePanel'));

function Harness() {
  const [helpOpen, setHelpOpen] = useState(false);
  const [arcadeOpen, setArcadeOpen] = useState(false);
  const [opened, setOpened] = useState('');
  const openFeature = (feature) => {
    setOpened(feature);
    if (feature === 'arcade') { setHelpOpen(false); setArcadeOpen(true); }
  };
  return (
    <div>
      <p data-testid="parent-secret">PARENT-DOM-SECRET-7d1f</p>
      <p data-testid="opened-log">{opened}</p>
      <button type="button" data-testid="open-help" onClick={() => setHelpOpen(true)}>Aide</button>
      <Dashboard
        lastSherlockJobId={null}
        activityEvents={[]}
        onOpenMetaGpt={() => setOpened('metagpt')}
        onOpenSherlock={() => setOpened('sherlock')}
        onOpenInvestment={() => setOpened('investment')}
        onOpenVideoSummary={() => setOpened('video')}
        onOpenSettings={() => setOpened('settings')}
        onQuickMetaGptMission={() => {}}
        onQuickSherlockSearch={() => {}}
        onQuickInvestmentAnalysis={() => {}}
        onQuickVideoRender={() => {}}
        launchers={{ arcade: () => openFeature('arcade'), todo: () => openFeature('todo') }}
      />
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} onOpenFeature={openFeature} />}
      {arcadeOpen && (
        <StudioShell icon={<Gamepad2 size={18} />} title="Arcade" onClose={() => setArcadeOpen(false)} subtitle="Jeux locaux isolés · sans réseau ni données Docteur">
          <Suspense fallback={<p>Chargement…</p>}><ArcadePanel /></Suspense>
        </StudioShell>
      )}
    </div>
  );
}

export function mount() {
  window.__arcadeSyntheticState = { secret: 'PARENT-STATE-SECRET-5f2a' };
  localStorage.setItem('docteur.arcade-test-secret', 'PARENT-LS-SECRET-91c2');
  sessionStorage.setItem('docteur.arcade-test-secret', 'PARENT-SS-SECRET-44ab');
  document.cookie = 'docteur_arcade_test=PARENT-COOKIE-SECRET; path=/';
  createRoot(document.getElementById('root')).render(<Harness />);
}
