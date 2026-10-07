// Agency V1 — browser harness: mounts the REAL AgencyStudioModal. /api/agency/** is answered
// in-process by the REAL agency route + service (in-memory SQLite) from the Playwright test.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import AgencyStudioModal from '../src/components/modals/AgencyStudioModal';

window.__agency = { imports: 0, closed: 0 };

export function mount() {
  createRoot(document.getElementById('root')).render(
    <AgencyStudioModal
      onClose={() => { window.__agency.closed += 1; }}
      onOutputsSaved={async () => { window.__agency.imports += 1; }}
    />,
  );
}
