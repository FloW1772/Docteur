import React from 'react';
import { createRoot } from 'react-dom/client';
import Modal from '../src/components/modals/VideoSummaryModal';
import { cortexClient } from '../src/lib/cortex/client';

export function mount() {
  window.calls = 0; window.done = 0;
  cortexClient.listVideoSummaryJobs = async () => [{ id: 'test', status: 'downloading' }];
  cortexClient.getVideoSummaryJob = async () => {
    window.calls++;
    return { job: { id: 'test', status: 'error', error_message: 'Le site refuse le téléchargement', disk_bytes: 0 }, segments: [] };
  };
  function Parent() {
    const [, setCount] = React.useState(0);
    return <Modal strictLocalMode onClose={() => {}} onDone={() => { window.done++; setCount(n => n + 1); }} />;
  }
  window.root = createRoot(document.getElementById('root'));
  window.root.render(<React.StrictMode><Parent /></React.StrictMode>);
}
