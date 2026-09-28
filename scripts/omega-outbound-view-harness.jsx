import React from 'react';
import { createRoot } from 'react-dom/client';
import { OmegaOutboundViewTab } from '../src/components/settings/OmegaOutboundViewTab';

export function mount() {
  createRoot(document.getElementById('root')).render(<OmegaOutboundViewTab />);
}
