import { useEffect, useState } from 'react';

// Easter egg "system offline" screen — deliberately has no way back except an
// actual page reload (F5). No close button, no ESC handler, on purpose.
export default function ShutdownOverlay() {
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowHint(true), 4000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      style={{
        position:       'fixed',
        inset:          0,
        zIndex:         999999,
        background:     '#000',
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        justifyContent: 'center',
        fontFamily:     'monospace',
        color:          '#3dffaa',
        animation:      'shutdown-flicker 0.4s ease-out',
      }}
    >
      <style>{`
        @keyframes shutdown-flicker {
          0%   { opacity: 0; }
          10%  { opacity: 1; }
          15%  { opacity: 0.2; }
          25%  { opacity: 1; }
          100% { opacity: 1; }
        }
        @keyframes shutdown-blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
      <div style={{ fontSize: 13, letterSpacing: '0.08em', textAlign: 'center', lineHeight: 1.8 }}>
        <div>SYSTÈME HORS LIGNE</div>
        <div style={{ color: '#5a4a7a', fontSize: 11, marginTop: 8 }}>
          connexion_neurale ... interrompue<span style={{ animation: 'shutdown-blink 1s step-end infinite' }}>_</span>
        </div>
      </div>
      {showHint && (
        <div style={{ position: 'absolute', bottom: 24, fontSize: 10, color: '#3a3050', letterSpacing: '0.05em' }}>
          Rechargez la page pour redémarrer (F5)
        </div>
      )}
    </div>
  );
}
