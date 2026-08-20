import { useEffect } from 'react';
import { Layers } from 'lucide-react';

interface Props {
  count:              number;
  operation:          string;   // "articles" | "vidéos"
  batchSize:          number;
  estimatedMinutes:   number;
  onConfirm:          () => void;
  onCancel:           () => void;
}

export default function ConfirmBatchModal({ count, operation, batchSize, estimatedMinutes, onConfirm, onCancel }: Props) {
  const lotCount = Math.ceil(count / batchSize);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter')  { e.preventDefault(); onConfirm(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(420px, calc(100vw - 24px))',
          border: '1px solid rgba(255,139,61,0.25)',
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden',
          boxShadow: '0 30px 90px rgba(0,0,0,0.56)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid rgba(255,139,61,0.12)' }}
        >
          <Layers size={15} style={{ color: '#ff8b3d', flexShrink: 0 }} />
          <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
            Opération volumineuse
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-4">
          <p className="font-mono text-sm" style={{ color: '#c0b0e0', lineHeight: 1.6 }}>
            Cette opération va créer{' '}
            <span style={{ color: '#f0eaff', fontWeight: 600 }}>{count} {operation}</span>
            {estimatedMinutes > 0 && (
              <span style={{ color: '#7a6c9a' }}> (~{estimatedMinutes} min)</span>
            )}
            .
          </p>

          <div
            className="font-mono text-xs px-3 py-2 rounded"
            style={{ background: 'rgba(255,139,61,0.06)', border: '1px solid rgba(255,139,61,0.15)', color: '#ff8b3d', lineHeight: 1.6 }}
          >
            Traitement par lots de {batchSize} — {lotCount} lots au total.
            <br />
            Annulable à tout moment après chaque lot.
          </div>

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className="modal-btn-cancel font-mono text-sm"
              onClick={onCancel}
            >
              Annuler
            </button>
            <button
              type="button"
              autoFocus
              onClick={onConfirm}
              className="font-mono text-sm px-4 py-2 rounded flex items-center gap-2"
              style={{
                background: 'rgba(61,255,170,0.1)',
                border:     '1px solid rgba(61,255,170,0.3)',
                color:      '#3dffaa',
                cursor:     'pointer',
              }}
            >
              Continuer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
