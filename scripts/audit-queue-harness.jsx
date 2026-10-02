import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import App from '../src/App';

export function mount() {
  createRoot(document.getElementById('root')).render(<App />);
}
