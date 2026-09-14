import React from 'react';
import { createRoot } from 'react-dom/client';
import ScreenCaptureModal from '../src/components/modals/ScreenCaptureModal';
import VideoSummaryModal from '../src/components/modals/VideoSummaryModal';

export function mount(screen = 'ocr', invalidImage = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 900; canvas.height = 180;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 900, 180);
  ctx.fillStyle = 'black'; ctx.font = '64px Arial';
  ctx.fillText('HELLO CORTEX 123', 30, 110);
  function Parent() {
    const [, setCount] = React.useState(0);
    return screen === 'video'
      ? <VideoSummaryModal strictLocalMode onClose={() => {}} onDone={() => setCount(n => n + 1)} />
      : <ScreenCaptureModal imageDataUrl={invalidImage ? 'data:image/png;base64,invalid' : canvas.toDataURL()}
          onClose={() => {}} onSaveImage={async () => {}} onSaveText={async () => {}} />;
  }
  window.testRoot = createRoot(document.getElementById('root'));
  window.testRoot.render(<React.StrictMode><Parent /></React.StrictMode>);
}
