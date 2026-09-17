import React, { lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import HelpModal from '../src/components/modals/HelpModal';
const Studio = lazy(() => import('../src/components/modals/InvestmentStudioModal'));
function Harness() {
  const [open, setOpen] = useState(false);
  return open ? <Suspense fallback={null}><Studio onClose={() => setOpen(false)} /></Suspense> : <HelpModal onClose={() => {}} onOpenFeature={feature => { if (feature === 'investment') setOpen(true); }} />;
}
export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
