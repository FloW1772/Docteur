import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import NotebookModal from '../src/components/modals/NotebookModal';

export function mount() {
  createRoot(document.getElementById('root')).render(<NotebookModal onClose={() => {}} />);
}
