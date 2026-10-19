// COMP-6B product harness: mount the real Docteur App. The test supplies only a loopback temporary Companion API.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import '../src/styles/globals.css';

export function mount() {
  window.__docteurCompanionProductRoot = createRoot(document.getElementById('root'));
  window.__docteurCompanionProductRoot.render(<App />);
}
