import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import { RassilonSettingsTab } from '../src/components/settings/RassilonSettingsTab';
import RassilonStatusBadge from '../src/components/rassilon/RassilonStatusBadge';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <main style={{ minHeight: '100vh', background: '#07050e', padding: 24 }}>
      <div data-testid="rassilon-badge-slot"><RassilonStatusBadge onOpen={() => setOpen(true)} pollMs={60_000} /></div>
      {open
        ? <RassilonSettingsTab pollMs={60_000} />
        : <button type="button" onClick={() => setOpen(true)}>OPEN RASSILON</button>}
    </main>
  );
}

export function mount() {
  createRoot(document.getElementById('root')).render(<Harness />);
}
