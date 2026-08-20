import { useEffect, useRef, useState } from 'react';
import { FileText, X, Loader2 } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';

// ── Types ──────────────────────────────────────────────────────────────────────

type PdfMode = 'basic' | 'complete';

interface NeuronExportProps {
  variant:  'neuron';
  pageId:   string;
  title:    string;
  onClose:  () => void;
  onToast?: (msg: string) => void;
}

interface SubjectExportProps {
  variant:        'subject';
  initialSubject?: string;
  onClose:        () => void;
  onToast?:       (msg: string) => void;
}

type Props = NeuronExportProps | SubjectExportProps;

// ── Helper: trigger browser download from a Blob ──────────────────────────────

function downloadBlob(blob: Blob, filename: string) {
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

function safeName(str: string) {
  return str.replace(/[^\wÀ-ɏ _-]/g, '').replace(/\s+/g, '_').slice(0, 80) || 'export';
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export default function PdfExportModal(props: Props) {
  const { onClose, onToast } = props;
  const isNeuron = props.variant === 'neuron';

  const [mode,    setMode]    = useState<PdfMode>('basic');
  const [subject, setSubject] = useState(
    props.variant === 'subject' ? (props.initialSubject ?? '') : '',
  );
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const subjectRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isNeuron) subjectRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !loading) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isNeuron, loading, onClose]);

  async function handleGenerate() {
    setError(null);
    setLoading(true);
    try {
      let blob: Blob;
      let filename: string;
      const today = new Date().toISOString().slice(0, 10);

      if (props.variant === 'neuron') {
        blob     = await cortexClient.exportNeuronPdf(props.pageId, mode);
        filename = `${safeName(props.title)}_${today}.pdf`;
      } else {
        const sub = subject.trim();
        if (!sub) { setError('Saisis un sujet.'); setLoading(false); return; }
        blob     = await cortexClient.exportSubjectPdf(sub, mode);
        filename = `${safeName(sub)}_${today}.pdf`;
      }

      downloadBlob(blob, filename);
      onToast?.('PDF téléchargé');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }

  const modeData: Array<{ id: PdfMode; label: string; desc: string }> = [
    {
      id:    'basic',
      label: 'Basique',
      desc:  isNeuron
        ? 'Titre, contenu formaté, date, source cliquable. Sobre et lisible.'
        : 'Liste structurée des neurones avec leurs contenus et sources.',
    },
    {
      id:    'complete',
      label: 'Complet',
      desc:  isNeuron
        ? 'Page de garde, sommaire, mise en page soignée, images, synapses en annexe, numérotation des pages.'
        : 'Page de garde, sommaire, introduction IA, organisation thématique, sources, numérotation.',
    },
  ];

  return (
    <div className="modal-backdrop" onClick={loading ? undefined : onClose}>
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width:        'min(460px, calc(100vw - 24px))',
          border:       '1px solid rgba(94,231,255,0.25)',
          borderRadius: 12,
          padding:      20,
          boxShadow:    '0 30px 90px rgba(0,0,0,0.56)',
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <FileText size={18} style={{ color: '#5ee7ff', flexShrink: 0 }} />
          <div className="flex-1">
            <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
              {isNeuron ? 'Exporter en PDF' : 'Export PDF — Sujet'}
            </h3>
            {isNeuron && (
              <p className="font-mono text-xs mt-0.5" style={{ color: '#9f8fbf' }}>
                {(props as NeuronExportProps).title || 'Sans titre'}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            style={{ color: '#5a4a7a' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#e8d9ff')}
            onMouseLeave={e => (e.currentTarget.style.color = '#5a4a7a')}
          >
            <X size={14} />
          </button>
        </div>

        {/* Subject input (subject mode only) */}
        {!isNeuron && (
          <div className="mb-4">
            <label className="font-mono text-xs mb-1.5 block" style={{ color: '#9f8fbf', letterSpacing: '0.1em' }}>
              SUJET
            </label>
            <input
              ref={subjectRef}
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !loading) void handleGenerate(); }}
              placeholder="Ex : intelligence artificielle, deep learning…"
              className="modal-search w-full"
              disabled={loading}
              style={{ padding: '10px 12px', borderRadius: 8 }}
            />
          </div>
        )}

        {/* Mode choice */}
        <div className="mb-5">
          <label className="font-mono text-xs mb-2 block" style={{ color: '#9f8fbf', letterSpacing: '0.1em' }}>
            FORMAT
          </label>
          <div className="flex flex-col gap-2">
            {modeData.map(m => {
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  disabled={loading}
                  className="text-left px-3 py-2.5 rounded transition-all"
                  style={{
                    background:   active ? 'rgba(94,231,255,0.09)' : 'rgba(255,255,255,0.02)',
                    border:       `1px solid ${active ? 'rgba(94,231,255,0.35)' : 'rgba(255,255,255,0.08)'}`,
                    cursor:       loading ? 'default' : 'pointer',
                  }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="font-mono text-xs font-semibold"
                      style={{ color: active ? '#5ee7ff' : '#9f8fbf', letterSpacing: '0.08em' }}
                    >
                      {m.label.toUpperCase()}
                    </span>
                    {active && (
                      <span
                        className="font-mono"
                        style={{ fontSize: 9, background: 'rgba(94,231,255,0.15)', color: '#5ee7ff', padding: '1px 6px', borderRadius: 4 }}
                      >
                        SÉLECTIONNÉ
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-xs" style={{ color: '#6a5a8a', lineHeight: 1.5 }}>
                    {m.desc}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Error */}
        {error && (
          <p className="font-mono text-xs mb-4 px-3 py-2 rounded" style={{ color: '#ff4d58', background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.2)' }}>
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            className="modal-btn-cancel font-mono text-sm"
            onClick={onClose}
            disabled={loading}
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={loading || (!isNeuron && !subject.trim())}
            className="font-mono text-sm flex items-center gap-2 px-4 py-2 rounded transition-all"
            style={{
              background:   loading ? 'rgba(94,231,255,0.06)' : 'rgba(94,231,255,0.12)',
              border:       '1px solid rgba(94,231,255,0.3)',
              color:        '#5ee7ff',
              cursor:       loading || (!isNeuron && !subject.trim()) ? 'default' : 'pointer',
              opacity:      !isNeuron && !subject.trim() && !loading ? 0.5 : 1,
            }}
          >
            {loading
              ? <><Loader2 size={13} className="animate-spin" /> Génération…</>
              : <><FileText size={13} /> Télécharger le PDF</>}
          </button>
        </div>

        {loading && (
          <p className="font-mono text-xs mt-3 text-center" style={{ color: '#6a5a8a' }}>
            {mode === 'complete'
              ? 'Génération en cours — mise en page complète avec rendu Mermaid…'
              : 'Génération du PDF…'}
          </p>
        )}
      </div>
    </div>
  );
}
