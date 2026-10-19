// Runtime Supervisor V1 — browser harness: mounts the REAL SettingsModal (or the bare Runtime tab). Every /api/runtime/*
// request is answered in-process by the Playwright suite with the REAL route + supervisor over test fixture processes;
// every other request is aborted and counted by the suite. Test-only file.
import React from 'react';
import { createRoot } from 'react-dom/client';
import SettingsModal from '../src/components/modals/SettingsModal';
import { RuntimeServicesSettingsTab } from '../src/components/settings/RuntimeServicesSettingsTab';

export function mount() {
  const cfg = window.__rsHarness ?? {};
  createRoot(document.getElementById('root')).render(
    <div style={{ background: '#020617', minHeight: '100vh' }}>
      {cfg.mode === 'tab'
        ? <RuntimeServicesSettingsTab baseUrl={window.location.origin} />
        : <SettingsModal onClose={() => { window.__closed = true; }} />}
    </div>,
  );
}
