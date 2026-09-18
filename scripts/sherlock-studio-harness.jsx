import React, { lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import HelpModal from '../src/components/modals/HelpModal';
const Studio = lazy(() => import('../src/components/modals/SherlockStudioModal'));
function Harness() {
  const [open, setOpen] = useState(false);
  const [lastJobId, setLastJobId] = useState('');
  return (
    <div>
      <p data-testid="last-job-id">{lastJobId}</p>
      {open ? (
        <Suspense fallback={null}>
          <Studio onClose={() => setOpen(false)} onJobUpdate={setLastJobId} />
        </Suspense>
      ) : (
        <HelpModal onClose={() => {}} onOpenFeature={feature => { if (feature === 'sherlock') setOpen(true); }} />
      )}
    </div>
  );
}
export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
