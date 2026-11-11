import { useState } from 'react';
import { Download } from 'lucide-react';
import { videoDownloadAvailability } from '../../lib/media/video-download';

type DownloadState = 'IDLE' | 'STARTED' | 'ERROR';

function startNativeDownload(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
}

export default function VideoDownloadButton({ href }: { href: string }) {
  const availability = videoDownloadAvailability(href);
  const [state, setState] = useState<DownloadState>('IDLE');
  if (!availability) return null;

  const directDownload = availability.status === 'available' ? availability : null;
  const unavailable = directDownload === null;
  const unavailableReason = availability.status === 'available' ? null : availability.reason;
  const label = state === 'STARTED' ? 'Téléchargement demandé' : unavailable ? 'Indisponible' : 'Télécharger';
  const status = state === 'STARTED'
    ? 'Téléchargement demandé au navigateur. Vérifiez ses téléchargements pour suivre le fichier.'
    : state === 'ERROR'
      ? 'Erreur : le téléchargement n’a pas pu démarrer.'
      : unavailableReason;

  function handleClick() {
    if (!directDownload || state === 'STARTED') return;
    try {
      startNativeDownload(directDownload.descriptor.url, directDownload.filename);
      setState('STARTED');
    } catch {
      setState('ERROR');
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 5, verticalAlign: 'middle', flexWrap: 'wrap' }}>
      <button
        type="button"
        data-testid="video-download-button"
        data-download-state={state}
        onClick={e => { e.stopPropagation(); handleClick(); }}
        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
        disabled={unavailable || state === 'STARTED'}
        aria-busy={false}
        aria-label={`${label} : ${availability.descriptor.title}`}
        title={unavailable ? unavailableReason ?? label : label}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          minHeight: 24, padding: '2px 7px', borderRadius: 4,
          border: `1px solid ${unavailable ? 'rgba(148,163,184,0.28)' : 'rgba(61,255,170,0.38)'}`,
          background: unavailable ? 'rgba(148,163,184,0.08)' : 'rgba(61,255,170,0.08)',
          color: unavailable ? '#8f86a8' : '#9fffc9',
          fontSize: 11, cursor: unavailable || state === 'STARTED' ? 'not-allowed' : 'pointer',
          opacity: unavailable ? 0.82 : 1, whiteSpace: 'nowrap', flexShrink: 0,
        }}
      >
        <Download size={13} aria-hidden="true" />{label}
      </button>
      {status && <span role="status" data-testid="video-download-status" style={{ minWidth: 0, fontSize: 11, color: state === 'ERROR' ? '#ff9b9b' : '#968bad' }}>{status}</span>}
    </span>
  );
}