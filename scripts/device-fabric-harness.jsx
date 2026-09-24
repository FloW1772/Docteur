import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import { DeviceFabricSettingsTab } from '../src/components/settings/DeviceFabricSettingsTab';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <main style={{ minHeight: '100vh', background: '#07050e', padding: 24 }}>
      {open
        ? <DeviceFabricSettingsTab />
        : <button type="button" onClick={() => setOpen(true)}>OPEN DEVICES</button>}
    </main>
  );
}

export function mount() {
  createRoot(document.getElementById('root')).render(<Harness />);
}
