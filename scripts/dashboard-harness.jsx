import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import Dashboard from '../src/components/hud/Dashboard';

// Isolated harness for the Dashboard layout — same approach as the other
// feature harnesses (metagpt-studio-harness.jsx etc.): mount the real
// component tree, mock only the network layer via page.route in the test
// script, never mock the component itself.
function Harness() {
  const [opened, setOpened] = useState('');
  return (
    <div>
      <p data-testid="opened-log">{opened}</p>
      <Dashboard
        lastSherlockJobId={null}
        activityEvents={[
          { id: 'e1', module: 'METAGPT', type: 'mission', label: 'Mission completed', status: 'done', timestamp: Date.now() - 30000 },
        ]}
        onOpenMetaGpt={() => setOpened('metagpt')}
        onOpenSherlock={() => setOpened('sherlock')}
        onOpenInvestment={() => setOpened('investment')}
        onOpenVideoSummary={() => setOpened('video')}
        onOpenSettings={() => setOpened('settings')}
        onQuickMetaGptMission={() => setOpened('quick-metagpt')}
        onQuickSherlockSearch={() => setOpened('quick-sherlock')}
        onQuickInvestmentAnalysis={() => setOpened('quick-investment')}
        onQuickVideoRender={() => setOpened('quick-video')}
      />
    </div>
  );
}

export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
