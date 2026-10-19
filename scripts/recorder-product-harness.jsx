// REC-WIRE-1 browser harness: mount the real Docteur App. Device substitution is installed by
// test-recorder-product-browser.mjs before this module loads; the product RecorderPanel itself is unchanged.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import '../src/styles/globals.css';

export function mount() {
  window.__docteurProductRoot = createRoot(document.getElementById('root'));
  window.__docteurProductRoot.render(<App />);
}
