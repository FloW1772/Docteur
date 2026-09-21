import React, { lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import HelpModal from '../src/components/modals/HelpModal';
const Studio = lazy(() => import('../src/components/modals/MaitreStudioModal'));
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      {open ? (
        <Suspense fallback={null}>
          <Studio onClose={() => setOpen(false)} />
        </Suspense>
      ) : (
        <HelpModal onClose={() => {}} onOpenFeature={feature => { if (feature === 'maitre') setOpen(true); }} />
      )}
    </div>
  );
}
export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
