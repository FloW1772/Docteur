// Model Router V1 — browser harness: mounts the REAL ModelRouterSection (Settings → Modèles).
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import { ModelRouterSection } from '../src/components/settings/ModelRouterSection';

export function mount() {
  createRoot(document.getElementById('root')).render(<div style={{ padding: 16, maxWidth: 1100, background: '#0b0716', minHeight: '100vh' }}><ModelRouterSection /></div>);
}
