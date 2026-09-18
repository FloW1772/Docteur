import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import CommandBar from '../src/components/hud/CommandBar';

function Harness() {
  const [submitted, setSubmitted] = useState('');
  const [voiceState, setVoiceState] = useState('idle');
  const [voiceClicks, setVoiceClicks] = useState(0);
  const [cancelled, setCancelled] = useState(false);
  const [showCancel, setShowCancel] = useState(false);

  return (
    <div>
      <p data-testid="submitted-log">{submitted}</p>
      <p data-testid="voice-clicks">{voiceClicks}</p>
      <p data-testid="cancelled-log">{cancelled ? 'cancelled' : ''}</p>
      <button type="button" onClick={() => setVoiceState(s => (s === 'idle' ? 'recording' : 'idle'))}>Toggle voice state (test-only)</button>
      <button type="button" onClick={() => setShowCancel(s => !s)}>Toggle cancel button (test-only)</button>
      <CommandBar
        cortexState="thinking"
        voiceEnabled
        voiceState={voiceState}
        onVoiceClick={() => setVoiceClicks(c => c + 1)}
        onSubmit={q => setSubmitted(q)}
        onCancel={showCancel ? () => setCancelled(true) : undefined}
      />
    </div>
  );
}

export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
