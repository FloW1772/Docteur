import { useEffect } from 'react';
import { X, HelpCircle } from 'lucide-react';
import { CAPABILITIES, LIMITATIONS, SHORTCUTS } from '../../content/capabilities';

interface Props {
  onClose: () => void;
}

export default function HelpModal({ onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(600px, calc(100vw - 24px))',
          border: '1px solid rgba(94,231,255,0.2)',
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden',
          boxShadow: '0 30px 90px rgba(0,0,0,0.56)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid rgba(94,231,255,0.1)', flexShrink: 0 }}
        >
          <HelpCircle size={16} style={{ color: '#5ee7ff', flexShrink: 0 }} />
          <div className="flex-1">
            <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
              Capacités de Docteur
            </h3>
            <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
              Ce que Docteur sait — et ne sait pas encore — faire
            </p>
          </div>
          <button type="button" title="Fermer (Echap)" style={{ color: '#5a4a7a' }} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>

          {/* Capabilities sections */}
          <div className="px-5 py-4 flex flex-col gap-5">
            {CAPABILITIES.map(section => (
              <div key={section.title}>
                <p
                  className="font-mono text-xs mb-2"
                  style={{ color: '#5ee7ff', letterSpacing: '0.15em' }}
                >
                  {section.emoji} {section.title}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {section.items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span style={{ color: '#3d3060', fontSize: 10, marginTop: 3, flexShrink: 0 }}>▸</span>
                      <span className="font-mono text-xs flex-1" style={{ color: '#c0b0e0', lineHeight: 1.6 }}>
                        {item.text}
                        {item.shortcut && (
                          <span
                            className="ml-2 px-1.5 rounded font-mono"
                            style={{
                              fontSize: 9,
                              background: 'rgba(94,231,255,0.08)',
                              color: '#5ee7ff',
                              border: '1px solid rgba(94,231,255,0.15)',
                              padding: '1px 6px',
                              verticalAlign: 'middle',
                            }}
                          >
                            {item.shortcut}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '0 20px' }} />

          {/* Limitations */}
          <div className="px-5 py-4">
            <p
              className="font-mono text-xs mb-2"
              style={{ color: '#ff8b3d', letterSpacing: '0.15em' }}
            >
              ⚠️ CE QUE DOCTEUR NE SAIT PAS ENCORE FAIRE
            </p>
            <ul className="flex flex-col gap-1.5">
              {LIMITATIONS.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span style={{ color: '#5a4a7a', fontSize: 10, marginTop: 3, flexShrink: 0 }}>—</span>
                  <span className="font-mono text-xs" style={{ color: '#7a6c9a', lineHeight: 1.6 }}>
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '0 20px' }} />

          {/* Shortcuts */}
          <div className="px-5 py-4">
            <p
              className="font-mono text-xs mb-2"
              style={{ color: '#a78bfa', letterSpacing: '0.15em' }}
            >
              ⌨️ RACCOURCIS CLAVIER
            </p>
            <div className="flex flex-col gap-1.5">
              {SHORTCUTS.map((s, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span
                    className="font-mono rounded"
                    style={{
                      fontSize: 10,
                      background: 'rgba(167,139,250,0.08)',
                      color: '#a78bfa',
                      border: '1px solid rgba(167,139,250,0.15)',
                      padding: '2px 8px',
                      minWidth: 120,
                      textAlign: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {s.keys}
                  </span>
                  <span className="font-mono text-xs" style={{ color: '#8070a8' }}>{s.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Footer hint */}
          <div className="px-5 pb-4">
            <p className="font-mono" style={{ fontSize: 9, color: '#3d3060' }}>
              Pour mettre à jour ce contenu : src/content/capabilities.ts
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
