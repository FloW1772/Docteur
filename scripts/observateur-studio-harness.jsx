import React, { lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import HelpModal from '../src/components/modals/HelpModal';
const ObservateurStudio = lazy(() => import('../src/components/modals/ObservateurStudioModal'));
const MaitreStudio = lazy(() => import('../src/components/modals/MaitreStudioModal'));
function Harness() {
  const [open, setOpen] = useState(false);
  const [maitreOpen, setMaitreOpen] = useState(false);
  return (
    <div>
      {maitreOpen ? (
        <Suspense fallback={null}>
          <MaitreStudio onClose={() => setMaitreOpen(false)} />
        </Suspense>
      ) : open ? (
        <Suspense fallback={null}>
          <ObservateurStudio
            onClose={() => setOpen(false)}
            onOpenMaitre={() => { setOpen(false); setMaitreOpen(true); }}
          />
        </Suspense>
      ) : (
        <HelpModal onClose={() => {}} onOpenFeature={feature => {
          if (feature === 'cyber-audit') { setOpen(true); }
          if (feature === 'maitre') { setMaitreOpen(true); }
        }} />
      )}
    </div>
  );
}
export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
