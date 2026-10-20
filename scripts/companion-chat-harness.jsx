// [COMP-9 CHAT] Browser harness: mounts the REAL Companion panel (with its chat) over the REAL HTTP port, in StrictMode
// like the App. Every /api/companion/* request is answered by scripts/test-companion-chat-browser.mjs; every other
// request is aborted and counted. Test-only file.
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import { CompanionPanel } from '../src/components/companion/CompanionPanel';
import { createHttpCompanionUiPort } from '../src/lib/companion/http-port';

export function mount() {
  // ?api=http://127.0.0.1:<port> lets the real-local harness point the panel at its own loopback route server
  const api = new URLSearchParams(window.location.search).get('api');
  const port = createHttpCompanionUiPort({ baseUrl: api && /^http:\/\/127\.0\.0\.1:\d+$/.test(api) ? api : 'http://127.0.0.1:3001' });
  const root = createRoot(document.getElementById('root'));
  root.render(<StrictMode><div style={{ padding: 16, background: '#020617', minHeight: '100vh', boxSizing: 'border-box' }}><CompanionPanel port={port} /></div></StrictMode>);
  window.__unmount = () => root.unmount();
}
