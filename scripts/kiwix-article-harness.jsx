// [KWX-2] browser harness: mounts the REAL Kiwix library modal. Every /api/kiwix/* request is answered by the Playwright suite
// (scripts/test-kiwix-article-timeout-browser.mjs) from in-test stubs; every other request is aborted and counted. Test-only file.
import React from 'react';
import { createRoot } from 'react-dom/client';
import KiwixLibraryModal from '../src/components/modals/KiwixLibraryModal';

export function mount() {
  createRoot(document.getElementById('root')).render(
    <div style={{ background: '#020617', minHeight: '100vh' }}>
      <KiwixLibraryModal onClose={() => { window.__closed = true; }} />
    </div>,
  );
}
