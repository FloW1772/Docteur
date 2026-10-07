// Browser Media Bridge V1 — mounts the REAL MediaReaderBoundary around a viewer that crashes,
// next to a neuron that must keep working.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import { MediaReaderBoundary } from '../src/components/media/MediaReader';

function Crash() { throw new Error('viewer exploded'); }

function Page() {
  const [open, setOpen] = useState(true);
  const [clicks, setClicks] = useState(0);
  return (
    <div>
      <div data-testid="neuron">Neurone intact <button type="button" onClick={() => setClicks(c => c + 1)}>Compter {clicks}</button></div>
      {open && <MediaReaderBoundary onClose={() => setOpen(false)}><Crash /></MediaReaderBoundary>}
    </div>
  );
}

export function mount() { createRoot(document.getElementById('root')).render(<Page />); }
