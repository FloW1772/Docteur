// [Knowledge Graph V1] KG-6 — browser harness: mounts the REAL KnowledgeGraphModal. /api/kg/** is
// answered in-process by the REAL KG route (temporary SQLite database) from the Playwright test.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import KnowledgeGraphModal from '../src/components/modals/KnowledgeGraphModal';
import { classifyMediaResource } from '../src/lib/media/media-resource';

window.__kg = { closed: 0, opened: [] };

// KG-CERT: like App.tsx, a URL opened from the KG goes to the Media Reader, whose classifier decides (recorded here)
export function mount() {
  createRoot(document.getElementById('root')).render(<KnowledgeGraphModal onClose={() => { window.__kg.closed += 1; }}
    onOpenUrl={(url, title) => { window.__kg.opened.push({ url, blocked: classifyMediaResource({ url, title }).blocked?.reason ?? null }); }} />);
}
