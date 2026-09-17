import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import HelpModal from '../src/components/modals/HelpModal';
import { SherlockSettingsSection } from '../src/components/settings/SherlockSettingsSection';
function Harness() {
  const [open, setOpen] = useState(false);
  return open ? <SherlockSettingsSection /> : <HelpModal onClose={() => {}} onOpenFeature={feature => { if (feature === 'settings-models') setOpen(true); }} />;
}
export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
