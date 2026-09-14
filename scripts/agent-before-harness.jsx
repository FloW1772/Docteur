import React from 'react';
import { createRoot } from 'react-dom/client';
import { usePages } from './pages-before';
function Harness() { window.before = usePages(); return null; }
export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
