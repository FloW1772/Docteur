// [Native Recorder] RECORDER-1 — browser harness: the REAL RecorderPanel + capture controller + HTTP port in Chromium.
// Camera / microphone: the REAL getUserMedia on Chromium's fake devices (--use-fake-device-for-media-stream: a
// synthetic test pattern and tone — no physical device). Screen: a SYNTHETIC canvas stream (the real getDisplayMedia
// is replaced by a function that throws, so the person's screen can never be captured by a test). The real
// MediaRecorder produces the chunks. /api/recorder/** is answered in-process by the REAL route factory + service.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RecorderPanel } from '../src/components/recorder/RecorderPanel';
import { createHttpRecorderPort } from '../src/lib/recorder/http-port';

const cfg = window.__recHarness ?? {};
const H = (window.__rec = { gum: 0, gdm: 0, tracks: [], screenTrack: null });
navigator.mediaDevices.getDisplayMedia = async () => { throw new Error('REAL getDisplayMedia must never be used by a test'); };
const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
const denied = () => new DOMException('Permission denied', 'NotAllowedError');

function syntheticScreen() {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const g = canvas.getContext('2d'); let n = 0;
  const draw = () => { g.fillStyle = `hsl(${(n * 7) % 360} 60% 40%)`; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText(`SYNTHETIC SCREEN ${n++}`, 20, 90); };
  draw(); const timer = setInterval(draw, 66);
  const stream = canvas.captureStream(15);
  const track = stream.getVideoTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => { clearInterval(timer); stop(); };
  H.screenTrack = track;
  return stream;
}
const env = {
  mediaDevices: {
    async getDisplayMedia() { H.gdm++; if (cfg.screenDenied) throw denied(); const s = syntheticScreen(); H.tracks.push(...s.getTracks()); return s; },
    async getUserMedia(c) {
      H.gum++;
      if (cfg.cameraDenied && c.video) throw denied();
      if (cfg.micDenied && c.audio && !c.video) throw denied();
      const s = await realGum(c); H.tracks.push(...s.getTracks()); return s;
    },
  },
  MediaRecorder: cfg.zeroData ? class ZeroDataRecorder extends MediaRecorder { set ondataavailable(_fn) { super.ondataavailable = () => {}; } get ondataavailable() { return super.ondataavailable; } } : window.MediaRecorder,
  now: () => performance.now(),
};
/** The person stops sharing from the browser / OS: the track ends and fires 'ended'. */
H.endScreen = () => { const t = H.screenTrack; t.stop(); t.dispatchEvent(new Event('ended')); };
H.liveTracks = () => H.tracks.filter(t => t.readyState !== 'ended').length;
// [REC-DL-1] renderer-side body reads are counted: a download must never be buffered in the page
H.bodyReads = { blob: 0, arrayBuffer: 0, fileReader: 0, objectUrl: 0 };
for (const [proto, name, key] of [[Response.prototype, 'blob', 'blob'], [Response.prototype, 'arrayBuffer', 'arrayBuffer'], [FileReader.prototype, 'readAsArrayBuffer', 'fileReader'], [FileReader.prototype, 'readAsDataURL', 'fileReader']]) {
  const orig = proto[name];
  proto[name] = function (...a) { H.bodyReads[key]++; return orig.apply(this, a); };
}
{ const orig = URL.createObjectURL; URL.createObjectURL = (...a) => { H.bodyReads.objectUrl++; return orig.apply(URL, a); }; }
const port = createHttpRecorderPort({ baseUrl: location.origin });

function Host() {
  const [mounted, setMounted] = useState(true);
  return (
    <div style={{ background: '#020617', minHeight: '100vh', padding: 16 }}>
      <button type="button" id="unmount" onClick={() => setMounted(false)}>Démonter le panneau</button>
      {mounted && <RecorderPanel port={port} env={env} timesliceMs={cfg.timesliceMs ?? 400} />}
    </div>
  );
}
export function mount() { createRoot(document.getElementById('root')).render(<Host />); }
