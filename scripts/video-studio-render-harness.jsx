import React from 'react';
import { createRoot } from 'react-dom/client';
import VideoSummaryModal from '../src/components/modals/VideoSummaryModal';

// Isolated harness for the merged Video Studio's new "RENDU (MP4)" tab
// (Phase UX-6) — mounts the real component directly on the render view so
// the OpenMontage flow (previously only reachable via Settings) is covered
// by a frontend browser test for the first time. No mocking of the
// component itself — only network responses via page.route in the test.
export function mount() {
  createRoot(document.getElementById('root')).render(
    <VideoSummaryModal strictLocalMode={false} onClose={() => {}} initialView="render" />,
  );
}
