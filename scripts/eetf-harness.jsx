// [EETF V1] EETF-7 — browser harness: mounts the REAL ImageGeneratorModal (legacy Image tab + EETF tabs).
// /api/image-generation/eetf/** is answered in-process by the REAL EETF route (temporary store, real FFmpeg);
// the legacy endpoints are answered by small fixtures. No external network.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import ImageGeneratorModal from '../src/components/modals/ImageGeneratorModal';

window.__eetfHarness = { closed: 0 };

function Host() {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" id="open-imggen" onClick={() => setOpen(true)}>Ouvrir le générateur</button>
      {open && <ImageGeneratorModal strictLocalMode={false} onClose={() => { window.__eetfHarness.closed += 1; setOpen(false); }} />}
    </div>
  );
}

export function mount() {
  createRoot(document.getElementById('root')).render(<Host />);
}
