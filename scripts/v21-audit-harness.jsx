import React, { useState, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import NeuralBrain from '../src/components/neural/NeuralBrain';
import Dashboard from '../src/components/hud/Dashboard';
import CommandBar from '../src/components/hud/CommandBar';
import CortexIdentity from '../src/components/hud/CortexIdentity';
import TopBar from '../src/components/layout/TopBar';
import Sidebar from '../src/components/layout/Sidebar';
import SidebarShell from '../src/components/layout/SidebarShell';
import { useMobile } from '../src/lib/useMobile';

// Read-only visual-audit harness for V2.1 planning — mounts the same render
// tree App.tsx composes (NeuralBrain backdrop + Dashboard rails + mode toggle
// + CommandBar) so the actual composition can be screenshotted at target
// viewports before any styling changes are made. Not a test; no assertions.

const SAMPLE_PAGES = Array.from({ length: 24 }, (_, i) => ({
  id: `p${i}`,
  title: `Neurone ${i}`,
  kind: i % 7 === 0 ? 'channel' : 'note',
  content: '',
  createdAt: Date.now() - i * 100000,
  updatedAt: Date.now() - i * 50000,
}));

function Harness() {
  const [viewMode, setViewMode] = useState('dashboard');
  const [cortexState, setCortexState] = useState('idle');
  const gestureInputRef = useRef(null);
  const [home, setHome] = useState(true);
  const [dialog, setDialog] = useState('');
  const mobile = useMobile();

  const onNodeSelect = useCallback(() => {}, []);

  return (
    <div className="docteur-shell" style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <div className="shell-topbar">
        <TopBar pageCount={SAMPLE_PAGES.length} cortexAvailable={true} cortexBusy={false} cortexQueueSize={0} cortexIndexCount={0}
          onSearchOpen={() => setDialog('Search')} onCaptureOpen={() => setDialog('Capture')}
          onSettingsOpen={() => setDialog('Settings')} onActivityPanelOpen={() => setDialog('Activity')}
          onTodoOpen={() => setDialog('Todo')} voiceEnabled={false} />
      </div>
      <SidebarShell mode={viewMode} mobile={mobile} onSearch={() => setDialog('Search')} onCapture={() => setDialog('Capture')}>
        <Sidebar pages={SAMPLE_PAGES} selectedPageId={null} loading={false} cortexAvailable={false}
          showHomeScreen={home} onToggleHomeScreen={setHome} onSelectPage={() => {}} onNewPage={() => {}}
          onDeletePage={() => {}} onRequestReindex={() => {}} onCaptureOpen={() => setDialog('Capture')}
          onSearchOpen={() => setDialog('Search')} />
      </SidebarShell>
      {dialog && <div role="dialog" aria-label={dialog} style={{position: 'fixed', zIndex: 1000, inset: '30%', background: '#0c1926'}}>
        {dialog}<button onClick={() => setDialog('')}>Close</button>
      </div>}
      {!new URLSearchParams(location.search).has('layoutOnly') && <NeuralBrain
        pages={SAMPLE_PAGES}
        selectedPageId={null}
        compact={false}
        className="brain-stage"
        onNodeSelect={onNodeSelect}
        indexingIds={new Set()}
        highlightedIds={new Set()}
        gestureInputRef={gestureInputRef}
        cortexState={cortexState}
      />}

      <CortexIdentity state={cortexState} />

      {viewMode === 'dashboard' && (
        <Dashboard
          lastSherlockJobId={null}
          activityEvents={[
            { id: 'e1', module: 'METAGPT', type: 'mission', label: 'Mission completed', status: 'done', timestamp: Date.now() - 30000 },
            { id: 'e2', module: 'SHERLOCK', type: 'search', label: 'Recherche terminée', status: 'done', timestamp: Date.now() - 120000 },
          ]}
          onOpenMetaGpt={() => {}}
          onOpenSherlock={() => {}}
          onOpenInvestment={() => {}}
          onOpenVideoSummary={() => {}}
          onOpenSettings={() => {}}
          onQuickMetaGptMission={() => {}}
          onQuickSherlockSearch={() => {}}
          onQuickInvestmentAnalysis={() => {}}
          onQuickVideoRender={() => {}}
        />
      )}

      <button
        type="button"
        className="hud2-mode-toggle"
        data-testid="mode-toggle"
        onClick={() => setViewMode(v => (v === 'dashboard' ? 'focus' : 'dashboard'))}
      >
        {viewMode === 'dashboard' ? 'Focus' : 'Dashboard'}
      </button>

      <CommandBar
        voiceEnabled={true}
        voiceState="idle"
        cortexState={cortexState}
        onSubmit={() => {}}
        onVoiceClick={() => {}}
      />

      <div data-testid="state-controls" style={{ position: 'fixed', bottom: 0, left: 8, zIndex: 999, display: 'flex', gap: 4 }}>
        {['idle', 'listening', 'thinking', 'searching', 'generating', 'done', 'error'].map(s => (
          <button key={s} data-testid={`set-state-${s}`} onClick={() => setCortexState(s)} style={{ fontSize: 10 }}>{s}</button>
        ))}
      </div>
    </div>
  );
}

export function mount() {
  createRoot(document.getElementById('root')).render(<Harness />);
}
