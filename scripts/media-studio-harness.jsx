// Media Studio V1 — browser harness: mounts the REAL MediaStudioModal.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import MediaStudioModal from '../src/components/modals/MediaStudioModal';

export function mount() {
  createRoot(document.getElementById('root')).render(<MediaStudioModal onClose={() => { window.__closed = true; }} />);
}
