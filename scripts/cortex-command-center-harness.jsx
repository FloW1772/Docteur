import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import ActivityPanel from '../src/components/layout/ActivityPanel';
import { deriveCortexState, CORTEX_STATE_LABEL } from '../src/hooks/useCortexState';

// Isolated harness for the Cortex Command Center pieces that don't require
// the full App.tsx tree (usePages/useCortex/cortexClient) to be mocked —
// same "test the new surface in isolation" approach as
// metagpt-studio-harness.jsx / sherlock-harness.jsx.
function Harness() {
  const [inputs, setInputs] = useState({
    cortexAvailable: true,
    cortexBusy: false,
    voiceState: 'idle',
    searchActive: false,
    generatingActive: false,
  });
  const [panelOpen, setPanelOpen] = useState(false);
  const state = deriveCortexState(inputs);

  const entries = [
    ...(inputs.cortexBusy ? [{ id: 'e1', label: 'Cortex indexe', detail: '3 en cours', state: 'thinking' }] : []),
    ...(inputs.generatingActive ? [{ id: 'e2', label: 'MetaGPT génère', state: 'generating' }] : []),
    ...(!inputs.cortexAvailable ? [{ id: 'e3', label: 'Serveur cognitif déconnecté', state: 'error' }] : []),
  ];

  return (
    <div>
      <p role="status" data-testid="cortex-state">{state}</p>
      <p data-testid="cortex-label">{CORTEX_STATE_LABEL[state]}</p>
      <button type="button" onClick={() => setInputs(i => ({ ...i, cortexBusy: !i.cortexBusy }))}>Toggle busy</button>
      <button type="button" onClick={() => setInputs(i => ({ ...i, voiceState: i.voiceState === 'idle' ? 'recording' : 'idle' }))}>Toggle listening</button>
      <button type="button" onClick={() => setInputs(i => ({ ...i, generatingActive: !i.generatingActive }))}>Toggle generating</button>
      <button type="button" onClick={() => setInputs(i => ({ ...i, cortexAvailable: !i.cortexAvailable }))}>Toggle available</button>
      <button type="button" onClick={() => setPanelOpen(o => !o)}>Toggle panel</button>
      <ActivityPanel cortexState={state} entries={entries} open={panelOpen} onClose={() => setPanelOpen(false)} />
    </div>
  );
}

export function mount() {
  createRoot(document.getElementById('root')).render(<Harness />);
}
