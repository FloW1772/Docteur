// [LOAD-1/LOAD-2] Browser harness: mounts the REAL boot screen (StartupGate) exactly like src/main.tsx does (StrictMode,
// global styles), with a stand-in application. Every request to :3001 is answered by the Playwright suite
// (scripts/test-startup-screen-browser.mjs); everything else is aborted and counted. Test-only file.
import React, { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import { StartupGate } from '../src/components/startup/StartupGate';

window.__appNet = 0; // mounted minus unmounted stand-in apps
function StandInApp() {
  useEffect(() => { window.__appNet += 1; return () => { window.__appNet -= 1; }; }, []);
  return <div data-testid="fake-app">Application Docteur (harness)</div>;
}
const renderReady = () => <StandInApp />;

export function mount() {
  const root = createRoot(document.getElementById('root'));
  root.render(<StrictMode><StartupGate renderReady={renderReady} /></StrictMode>);
  window.__unmountGate = () => root.unmount();
}
