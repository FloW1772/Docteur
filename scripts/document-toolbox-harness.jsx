// Document Toolbox PDF V1 — browser harness: mounts the REAL DocumentToolboxModal.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import DocumentToolboxModal from '../src/components/modals/DocumentToolboxModal';

export function mount() {
  createRoot(document.getElementById('root')).render(<DocumentToolboxModal onClose={() => { window.__closed = true; }} />);
}
