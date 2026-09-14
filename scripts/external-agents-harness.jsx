import React from 'react';
import { createRoot } from 'react-dom/client';
import ExternalAgentsPanel from '../src/components/panels/ExternalAgentsPanel';
export function mount() { createRoot(document.getElementById('root')).render(<ExternalAgentsPanel />); }
